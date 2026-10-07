import { json, options } from '../_lib/http.js';
import { db, requireUser } from '../_lib/supabase.js';

export async function POST(request) {
  const requestId = request.headers.get('x-client-request-id') || crypto.randomUUID();
  try {
    const user = await requireUser(request);
    if (!user) return json(request, { error: 'Sign in is required for background transcription.', requestId }, 401, requestId);
    const body = await request.json();
    const meetingId = String(body.meetingId || '').trim();
    const language = String(body.language || 'auto');
    const chunks = Array.isArray(body.chunks) ? body.chunks : [];
    if (!meetingId || !chunks.length || chunks.length > 240) return json(request, { error: 'A meeting and 1–240 audio chunks are required.', requestId }, 400, requestId);
    const normalized = chunks.map((chunk, index) => ({
      sequence: index,
      storage_path: String(chunk.storagePath || ''),
      duration_seconds: Math.max(0, Number(chunk.durationSeconds) || 0),
      bytes: Math.max(0, Number(chunk.bytes) || 0),
      sha256: chunk.sha256 ? String(chunk.sha256) : null
    }));
    if (normalized.some(chunk => !chunk.storage_path.startsWith(`${user.id}/`) || chunk.bytes > 24 * 1024 * 1024)) {
      return json(request, { error: 'One or more audio chunks are invalid.', requestId }, 400, requestId);
    }
    const idempotencyKey = String(request.headers.get('idempotency-key') || body.idempotencyKey || `${user.id}:${meetingId}`).slice(0, 200);
    const created = await db('rpc/create_transcription_job', {
      method: 'POST',
      body: JSON.stringify({ p_user_id: user.id, p_meeting_id: meetingId, p_language: language, p_idempotency_key: idempotencyKey, p_chunks: normalized }),
      headers: { prefer: 'return=representation' }
    });
    const jobId = typeof created === 'string' ? created : created?.id || created?.[0]?.id;
    return json(request, { jobId, status: 'queued', requestId }, 202, requestId);
  } catch (error) {
    console.error(JSON.stringify({ event: 'transcription_job_create_failed', requestId, error: error instanceof Error ? error.message : String(error) }));
    return json(request, { error: 'The background transcription job could not be created.', requestId }, 500, requestId);
  }
}

export const OPTIONS = options;
