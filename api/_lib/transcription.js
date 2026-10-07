const MODEL_COST_PER_MINUTE_USD = {
  'gpt-4o-transcribe-diarize': 0.006,
  'gpt-4o-mini-transcribe': 0.003
};

export async function transcribeAudio(audio, { language = 'auto', requestId = crypto.randomUUID() } = {}) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error('AI service is not configured.');
  const models = [
    { name: 'gpt-4o-transcribe-diarize', format: 'diarized_json', chunking: true },
    { name: 'gpt-4o-mini-transcribe', format: 'json', chunking: false }
  ];
  let lastFailure;
  for (const model of models) {
    const form = new FormData();
    form.append('file', audio, audio.name || 'meeting.wav');
    form.append('model', model.name);
    form.append('response_format', model.format);
    if (model.chunking) form.append('chunking_strategy', 'auto');
    if (language && language !== 'auto') form.append('language', language);
    try {
      const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
        method: 'POST', headers: { authorization: `Bearer ${key}` }, body: form, signal: AbortSignal.timeout(70000)
      });
      const raw = await response.text();
      let data;
      try { data = JSON.parse(raw); } catch { data = null; }
      if (response.ok && data) return normalize(data, model.name);
      const retryable = response.status === 408 || response.status === 409 || response.status === 429 || response.status >= 500 || data === null;
      lastFailure = Object.assign(new Error(data?.error?.message || `Transcription failed (${response.status}).`), { retryable, status: response.status });
      console.warn(JSON.stringify({ event: 'background_transcription_attempt_failed', requestId, model: model.name, status: response.status, upstreamRequestId: response.headers.get('x-request-id') || '' }));
      if (!retryable) throw lastFailure;
    } catch (error) {
      if (error === lastFailure && !error.retryable) throw error;
      lastFailure = Object.assign(error instanceof Error ? error : new Error(String(error)), { retryable: true });
    }
  }
  throw lastFailure || Object.assign(new Error('Transcription temporarily unavailable.'), { retryable: true });
}

function normalize(data, model) {
  const segments = Array.isArray(data.segments) ? data.segments.filter(item => item?.text).map(item => ({
    speaker: String(item.speaker || 'Speaker'), text: String(item.text).trim(), start: Number(item.start) || 0, end: Number(item.end) || 0
  })) : [];
  const duration = Number(data.duration) || 0;
  const transcript = segments.length ? segments.map(item => `[${stamp(item.start)}] ${item.speaker}: ${item.text}`).join('\n\n') : String(data.text || '').trim();
  return { transcript, segments, duration, model, estimatedCostUsd: (duration / 60) * (MODEL_COST_PER_MINUTE_USD[model] || 0.006) };
}

function stamp(seconds) {
  return `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
}
