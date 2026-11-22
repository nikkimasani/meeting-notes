export async function respond(key, body) {
  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120000)
  });
  const data = await response.json().catch(() => null);
  if (!response.ok || !data) {
    const error = new Error(data?.error?.message || `AI request failed (${response.status}).`);
    error.status = response.status;
    throw error;
  }
  const text = data.output?.flatMap(item => item.content || []).find(item => item.type === 'output_text')?.text;
  if (!text) throw Object.assign(new Error('The AI returned an empty response.'), { status: 502 });
  return text;
}
export const NOTES_MODEL = process.env.NOTES_MODEL || 'gpt-4.1-mini';
