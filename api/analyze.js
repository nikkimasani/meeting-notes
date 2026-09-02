export const config = { runtime: 'edge' };

export default async function handler(request) {
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  const key = process.env.OPENAI_API_KEY;
  if (!key) return json({ error: 'AI service is not configured.' }, 503);
  try {
    const { transcript, title = 'Meeting' } = await request.json();
    if (!transcript?.trim()) return json({ error: 'A transcript is required.' }, 400);
    if (transcript.length > 180000) return json({ error: 'Transcript is too long.' }, 413);
    const schema = {
      type: 'object', additionalProperties: false,
      properties: {
        summary: { type: 'string' },
        key_points: { type: 'array', items: { type: 'string' } },
        decisions: { type: 'array', items: { type: 'string' } },
        action_items: { type: 'array', items: { type: 'object', additionalProperties: false, properties: {
          task: { type: 'string' }, owner: { type: ['string','null'] }, due: { type: ['string','null'] }, priority: { type: 'string', enum: ['low','medium','high'] }
        }, required: ['task','owner','due','priority'] } },
        topics: { type: 'array', items: { type: 'string' } },
        follow_up: { type: 'array', items: { type: 'string' } }
      }, required: ['summary','key_points','decisions','action_items','topics','follow_up']
    };
    const response = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4.1-mini',
        instructions: 'You turn meeting transcripts into concise, accurate notes. Never invent facts, owners, dates, decisions, or tasks. Keep the summary distinct from the transcript. Extract action items only when the transcript supports them. Use null when owner or due date is unstated.',
        input: `Meeting title: ${title}\n\nTranscript:\n${transcript}`,
        text: { format: { type: 'json_schema', name: 'meeting_analysis', strict: true, schema } }
      })
    });
    const data = await response.json();
    if (!response.ok) return json({ error: data.error?.message || 'Meeting analysis failed.' }, response.status);
    const text = data.output?.flatMap(item => item.content || []).find(item => item.type === 'output_text')?.text;
    if (!text) return json({ error: 'AI returned no analysis.' }, 502);
    return json(JSON.parse(text));
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : 'Meeting analysis failed.' }, 500);
  }
}
function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
}
