import { json } from '../_lib/http.js';
import { db, downloadObject } from '../_lib/supabase.js';
import { transcribeAudio } from '../_lib/transcription.js';
import { waitUntil } from '@vercel/functions';

const MAX_CHUNKS_PER_RUN = 4;
const MAX_CHUNK_ATTEMPTS = 4;

export async function GET(request) { return run(request); }
export async function POST(request) { return run(request); }

async function run(request) {
  const requestId = request.headers.get('x-client-request-id') || crypto.randomUUID();
  if (!authorized(request)) return json(request, { error: 'Unauthorized.', requestId }, 401, requestId);
  let processed = 0;
  try {
    for (; processed < MAX_CHUNKS_PER_RUN; processed++) {
      const claimed = await db('rpc/claim_transcription_chunk', { method: 'POST', body: '{}' });
      const chunk = Array.isArray(claimed) ? claimed[0] : claimed;
      if (!chunk?.chunk_id) break;
      await processChunk(chunk, requestId);
    }
    if (processed === MAX_CHUNKS_PER_RUN) continueDraining(request, requestId);
    return json(request, { processed, continuing: processed === MAX_CHUNKS_PER_RUN, requestId });
  } catch (error) {
    console.error(JSON.stringify({ event: 'transcription_worker_failed', requestId, processed, error: error instanceof Error ? error.message : String(error) }));
    return json(request, { error: 'Worker run failed.', processed, requestId }, 500, requestId);
  }
}

async function processChunk(chunk, requestId) {
  const startedAt = Date.now();
  try {
    const blob = await downloadObject(chunk.storage_path);
    const audio = new File([blob], `part-${chunk.sequence + 1}.wav`, { type: blob.type || 'audio/wav' });
    const result = await transcribeAudio(audio, { language: chunk.language, requestId });
    await db('rpc/complete_transcription_chunk', {
      method: 'POST',
      body: JSON.stringify({
        p_chunk_id: chunk.chunk_id,
        p_transcript: result.transcript,
        p_segments: result.segments,
        p_duration_seconds: result.duration || chunk.duration_seconds,
        p_model: result.model,
        p_estimated_cost_usd: result.estimatedCostUsd
      })
    });
    console.info(JSON.stringify({ event: 'transcription_chunk_completed', requestId, jobId: chunk.job_id, chunkId: chunk.chunk_id, sequence: chunk.sequence, elapsedMs: Date.now() - startedAt }));
  } catch (error) {
    const retryable = error?.retryable !== false;
    const terminal = !retryable || Number(chunk.attempt_count) >= MAX_CHUNK_ATTEMPTS;
    await db('rpc/fail_transcription_chunk', {
      method: 'POST',
      body: JSON.stringify({ p_chunk_id: chunk.chunk_id, p_error: error instanceof Error ? error.message.slice(0, 1000) : String(error).slice(0, 1000), p_terminal: terminal })
    });
    if (!terminal) {
      const retryDelayMs = Math.min(30000, Math.pow(2, Math.max(Number(chunk.attempt_count), 1)) * 5000);
      await new Promise(resolve => setTimeout(resolve, retryDelayMs));
    }
    console.warn(JSON.stringify({ event: 'transcription_chunk_failed', requestId, jobId: chunk.job_id, chunkId: chunk.chunk_id, sequence: chunk.sequence, attempt: chunk.attempt_count, terminal, error: error instanceof Error ? error.message : String(error) }));
  }
}

function authorized(request) {
  const expected = process.env.CRON_SECRET;
  if (!expected) return false;
  const authorization = request.headers.get('authorization') || '';
  return authorization === `Bearer ${expected}`;
}

function continueDraining(request, requestId) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return;
  waitUntil(fetch(new URL('/api/transcription-jobs/process', request.url), {
    method: 'POST',
    headers: { authorization: `Bearer ${secret}`, 'x-client-request-id': requestId }
  }).catch(error => console.error(JSON.stringify({
    event: 'transcription_worker_redispatch_failed',
    requestId,
    error: error instanceof Error ? error.message : String(error)
  }))));
}
