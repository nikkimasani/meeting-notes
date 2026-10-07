export async function POST(request) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return json({ error: 'AI service is not configured.' }, 503);
  try {
    const incoming = await request.formData();
    const audio = incoming.get('audio');
    if (!(audio instanceof File) || !audio.size) return json({ error: 'No audio was received.' }, 400);
    if (audio.size > 24 * 1024 * 1024) return json({ error: 'Recording is larger than 24 MB. Import a shorter recording.' }, 413);
    const language = incoming.get('language');
    let result;
    const models = [
      { name: 'gpt-4o-transcribe-diarize', format: 'diarized_json', chunking: true },
      { name: 'gpt-transcribe', format: 'json', chunking: false }
    ];
    for (const model of models) {
      for (let attempt = 0; attempt < 2; attempt++) {
        result = await transcribe(audio, language, key, model);
        if (result.ok) break;
        if (!result.temporary) return json({ error: result.data?.error?.message || 'Transcription failed.' }, result.status);
        if (attempt < 1) await new Promise(resolve => setTimeout(resolve, 500));
      }
      if (result?.ok) break;
    }
    if (!result?.ok || !result.data) return json({ error: 'The transcription service is temporarily unavailable. Your recording is safe; please try again shortly.' }, 502);
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
    return json({ transcript, segments, duration: Number(data.duration) || 0 });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : 'Transcription failed.' }, 500);
  }
}
async function transcribe(audio, language, key, model) {
  const form = new FormData();
  form.append('file', audio, audio.name || 'meeting.webm');
  form.append('model', model.name);
  form.append('response_format', model.format);
  if (model.chunking) form.append('chunking_strategy', 'auto');
  if (language && language !== 'auto') form.append('language', language);
  try {
    const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST', headers: { Authorization: `Bearer ${key}` }, body: form
    });
    const raw = await response.text();
    let data;
    try { data = JSON.parse(raw); } catch { data = null; }
    return {
      ok: response.ok && data !== null,
      temporary: response.status === 429 || response.status >= 500 || data === null,
      status: response.status,
      data
    };
  } catch {
    return { ok: false, temporary: true, status: 502, data: null };
  }
}
function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
}
