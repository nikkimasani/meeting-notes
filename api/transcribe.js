export async function POST(request) {
  const requestId = request.headers.get('x-client-request-id') || crypto.randomUUID();
  const startedAt = Date.now();
  const respond = (body, status = 200) => json({ ...body, requestId }, status, requestId);
  const key = process.env.OPENAI_API_KEY;
  if (!key) return respond({ error: 'AI service is not configured.' }, 503);
  try {
    const incoming = await request.formData();
    const audio = incoming.get('audio');
    if (!(audio instanceof File) || !audio.size) return respond({ error: 'No audio was received.' }, 400);
    if (audio.size > 24 * 1024 * 1024) return respond({ error: 'Recording is larger than 24 MB. Import a shorter recording.' }, 413);
    const language = incoming.get('language');
    console.info(JSON.stringify({ event: 'transcription_started', requestId, bytes: audio.size, type: audio.type }));
    let result;
    const models = [
      { name: 'gpt-4o-transcribe-diarize', format: 'diarized_json', chunking: true },
      { name: 'gpt-transcribe', format: 'json', chunking: false }
    ];
    for (const model of models) {
      result = await transcribe(audio, language, key, model, requestId);
      if (!result.temporary && !result.ok) return respond({ error: result.data?.error?.message || 'Transcription failed.' }, result.status);
      if (result?.ok) break;
    }
    if (!result?.ok || !result.data) return respond({ error: 'The transcription service is temporarily unavailable. Your recording is safe; please try again shortly.' }, 502);
    const data = result.data;
    const segments = Array.isArray(data.segments) ? data.segments.filter(segment => segment && segment.text).map(segment => ({
      speaker: String(segment.speaker || 'Speaker'),
      text: String(segment.text).trim(),
      start: Number(segment.start) || 0,
      end: Number(segment.end) || 0
    })) : [];
    const stamp = seconds => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
    const transcript = segments.length
      ? segments.map(segment => `[${stamp(segment.start)}] ${segment.speaker}: ${segment.text}`).join('\n\n')
      : data.text || '';
    console.info(JSON.stringify({ event: 'transcription_completed', requestId, elapsedMs: Date.now() - startedAt, transcriptChars: transcript.length }));
    return respond({ transcript, segments, duration: Number(data.duration) || 0 });
  } catch (error) {
    console.error(JSON.stringify({ event: 'transcription_failed', requestId, elapsedMs: Date.now() - startedAt, error: error instanceof Error ? error.message : String(error) }));
    return respond({ error: error instanceof Error ? error.message : 'Transcription failed.' }, 500);
  }
}
export async function OPTIONS() {
  return new Response(null, { status: 204, headers: corsHeaders() });
}
async function transcribe(audio, language, key, model, requestId) {
  const form = new FormData();
  form.append('file', audio, audio.name || 'meeting.webm');
  form.append('model', model.name);
  form.append('response_format', model.format);
  if (model.chunking) form.append('chunking_strategy', 'auto');
  if (language && language !== 'auto') form.append('language', language);
  try {
    const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST', headers: { Authorization: `Bearer ${key}` }, body: form, signal: AbortSignal.timeout(60000)
    });
    const raw = await response.text();
    let data;
    try { data = JSON.parse(raw); } catch { data = null; }
    if (!response.ok || data === null) console.warn(JSON.stringify({
      event: 'transcription_attempt_failed',
      requestId,
      model: model.name,
      status: response.status,
      contentType: response.headers.get('content-type') || '',
      upstreamRequestId: response.headers.get('x-request-id') || ''
    }));
    return {
      ok: response.ok && data !== null,
      temporary: response.status === 429 || response.status >= 500 || data === null,
      status: response.status,
      data
    };
  } catch (error) {
    console.warn(JSON.stringify({ event: 'transcription_attempt_failed', requestId, model: model.name, status: 0, error: error instanceof Error ? error.name : String(error) }));
    return { ok: false, temporary: true, status: 502, data: null };
  }
}
function json(body, status = 200, requestId = '') {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders(), 'content-type': 'application/json', 'cache-control': 'no-store', 'x-transcription-request-id': requestId } });
}
function corsHeaders() {
  return {
    'access-control-allow-origin': 'https://meeting-notes-cloudflare.pages.dev',
    'access-control-allow-methods': 'POST, OPTIONS',
    'access-control-allow-headers': 'content-type, x-client-request-id',
    'access-control-expose-headers': 'x-transcription-request-id'
  };
}
