export const config = { runtime: 'edge' };

export default async function handler(request) {
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  const key = process.env.OPENAI_API_KEY;
  if (!key) return json({ error: 'AI service is not configured.' }, 503);
  try {
    const { title = 'Meeting', attendees = '', summary = '', actions = [], decisions = [], openQuestions = [] } = await request.json();
    if (!summary.trim()) return json({ error: 'Generate a meeting summary first.' }, 400);
    const response = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4.1-mini',
        instructions: 'Draft a concise professional follow-up email. Use only the supplied meeting information. Include a clear subject, brief recap, decisions, action items with owners or due dates when supplied, and unresolved questions. Do not invent facts. Return plain text.',
        input: `Title: ${title}\nAttendees: ${attendees || 'Not listed'}\n\nSummary:\n${summary.slice(0, 30000)}\n\nDecisions:\n${decisions.join('\n')}\n\nAction items:\n${actions.join('\n')}\n\nOpen questions:\n${openQuestions.join('\n')}`
      })
    });
    const data = await response.json();
    if (!response.ok) return json({ error: data.error?.message || 'Follow-up draft failed.' }, response.status);
    const email = data.output?.flatMap(item => item.content || []).find(item => item.type === 'output_text')?.text;
    return json({ email: email || 'No email draft was returned.' });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : 'Follow-up draft failed.' }, 500);
  }
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
}
