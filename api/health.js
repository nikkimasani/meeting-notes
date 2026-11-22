import { json } from './_lib/http.js';
import { respond, NOTES_MODEL } from './_lib/openai.js';

// GET /api/health          -> configuration check
// GET /api/health?deep=1   -> speaks a short sentence with TTS, transcribes it
//                             with speaker labels, and summarizes it (≈ $0.002).
export async function GET(request) {
  const key = process.env.OPENAI_API_KEY;
  const out = { ok: !!key, configured: !!key, notesModel: NOTES_MODEL, checks: {} };
  if (!key || new URL(request.url).searchParams.get('deep') !== '1') return json(request, out, key ? 200 : 503);
  const step = async (name, fn) => {
    const t = Date.now();
    try { const value = await fn(); out.checks[name] = { ok: true, ms: Date.now() - t, value }; return value; }
    catch (e) { out.ok = false; out.checks[name] = { ok: false, ms: Date.now() - t, error: e.message }; return null; }
  };
  const audio = await step('tts', async () => {
    const r = await fetch('https://api.openai.com/v1/audio/speech', {
      method: 'POST', headers: { Authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-4o-mini-tts', voice: 'alloy', response_format: 'wav', input: 'Hi team. Quick update: Sam will send the budget by Friday, and we agreed to launch the trailer on the third.' })
    });
    if (!r.ok) throw new Error(`TTS ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const buf = await r.arrayBuffer();
    return { bytes: buf.byteLength, buf };
  });
  let transcript = '';
  if (audio) {
    for (const model of ['gpt-4o-transcribe-diarize', 'gpt-4o-transcribe']) {
      await step(model, async () => {
        const form = new FormData();
        form.append('file', new File([audio.buf], 'test.wav', { type: 'audio/wav' }));
        form.append('model', model);
        form.append('response_format', model.endsWith('diarize') ? 'diarized_json' : 'json');
        if (model.endsWith('diarize')) form.append('chunking_strategy', 'auto');
        const r = await fetch('https://api.openai.com/v1/audio/transcriptions', { method: 'POST', headers: { Authorization: `Bearer ${key}` }, body: form });
        const data = await r.json().catch(() => null);
        if (!r.ok) throw new Error(`${r.status}: ${data?.error?.message || 'failed'}`);
        transcript = transcript || data.text;
        return { text: data.text, segments: (data.segments || []).length };
      });
    }
    delete audio.buf;
  }
  if (transcript) {
    await step('notes', async () => {
      const text = await respond(key, { model: NOTES_MODEL, input: `Summarize in one sentence: ${transcript}` });
      return text.slice(0, 200);
    });
  }
  return json(request, out, out.ok ? 200 : 502);
}
