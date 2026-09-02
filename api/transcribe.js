export const config = { runtime: 'edge' };

export default async function handler(request) {
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  const key = process.env.OPENAI_API_KEY;
  if (!key) return json({ error: 'AI service is not configured.' }, 503);
  try {
    const incoming = await request.formData();
    const audio = incoming.get('audio');
    if (!(audio instanceof File) || !audio.size) return json({ error: 'No audio was received.' }, 400);
    if (audio.size > 24 * 1024 * 1024) return json({ error: 'Recording is larger than 24 MB. Import a shorter recording.' }, 413);
    const form = new FormData();
    form.append('file', audio, audio.name || 'meeting.webm');
    form.append('model', 'gpt-4o-transcribe-diarize');
    form.append('response_format', 'diarized_json');
    form.append('chunking_strategy', 'auto');
    const language = incoming.get('language');
    if (language && language !== 'auto') form.append('language', language);
    const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST', headers: { Authorization: `Bearer ${key}` }, body: form
    });
    const data = await response.json();
    if (!response.ok) return json({ error: data.error?.message || 'Transcription failed.' }, response.status);
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
