export default async function handler(request) {
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  const key = process.env.OPENAI_API_KEY;
  if (!key) return json({ error: 'AI service is not configured.' }, 503);
  try {
    const incoming = await request.formData();
    const audio = incoming.get('audio');
    if (!(audio instanceof File) || !audio.size) return json({ error: 'No audio was received.' }, 400);
    if (audio.size > 24 * 1024 * 1024) return json({ error: 'Recording is larger than 24 MB. Import a shorter recording.' }, 413);
    const language = incoming.get('language');
    let response;
    let data;
    for (let attempt = 0; attempt < 3; attempt++) {
      const form = new FormData();
      form.append('file', audio, audio.name || 'meeting.webm');
      form.append('model', 'gpt-4o-transcribe-diarize');
      form.append('response_format', 'diarized_json');
      form.append('chunking_strategy', 'auto');
      if (language && language !== 'auto') form.append('language', language);
      try {
        response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
          method: 'POST', headers: { Authorization: `Bearer ${key}` }, body: form
        });
      } catch {
        if (attempt < 2) {
          await new Promise(resolve => setTimeout(resolve, 500 * (attempt + 1)));
          continue;
        }
        return json({ error: 'The transcription service is temporarily unavailable. Your recording is safe; please try again shortly.' }, 502);
      }
      const raw = await response.text();
      try {
        data = JSON.parse(raw);
      } catch {
        data = null;
      }
      const temporary = response.status === 429 || response.status >= 500 || data === null;
      if (response.ok && data) break;
      if (temporary && attempt < 2) {
        await new Promise(resolve => setTimeout(resolve, 500 * (attempt + 1)));
        continue;
      }
      if (!data) return json({ error: 'The transcription service is temporarily unavailable. Your recording is safe; please try again shortly.' }, 502);
      return json({ error: data.error?.message || 'Transcription failed.' }, response.status);
    }
    if (!response?.ok || !data) return json({ error: 'The transcription service is temporarily unavailable. Your recording is safe; please try again shortly.' }, 502);
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
function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
}
