export const config = { runtime: 'edge' };

export default async function handler(request) {
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  const key = process.env.OPENAI_API_KEY;
  if (!key) return json({ error: 'AI service is not configured.' }, 503);
  try {
    const { question, transcript, summary = '' } = await request.json();
    if (!question?.trim() || !transcript?.trim()) return json({ error: 'Question and transcript are required.' }, 400);
    const response = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4.1-mini',
        instructions: 'Answer only from the supplied meeting notes. If the answer is not present, say that it was not discussed. Be concise and cite the relevant wording or topic without inventing details.',
        input: `Summary:\n${summary}\n\nTranscript:\n${transcript}\n\nQuestion: ${question}`
      })
    });
    const data = await response.json();
    if (!response.ok) return json({ error: data.error?.message || 'Question failed.' }, response.status);
    const answer = data.output?.flatMap(item => item.content || []).find(item => item.type === 'output_text')?.text;
    return json({ answer: answer || 'No answer was returned.' });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : 'Question failed.' }, 500);
  }
}
function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
}
