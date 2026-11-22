import { json, options } from './_lib/http.js';
import { respond, NOTES_MODEL } from './_lib/openai.js';

export async function POST(request) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return json(request, { error: 'AI service is not configured.' }, 503);
  try {
    const { messages = [], context = '', scope = 'meeting' } = await request.json();
    const clean = (Array.isArray(messages) ? messages : [])
      .filter(m => m && (m.role === 'user' || m.role === 'assistant') && String(m.content || '').trim())
      .slice(-16)
      .map(m => ({ role: m.role, content: String(m.content).slice(0, 8000) }));
    if (!clean.length || clean[clean.length - 1].role !== 'user') return json(request, { error: 'Ask a question first.' }, 400);
    if (!String(context).trim()) return json(request, { error: 'There are no meeting notes to answer from yet.' }, 400);
    const instructions = scope === 'library'
      ? 'You are an assistant for a person\'s meeting library. Answer only from the meeting excerpts provided. Each excerpt starts with a meeting title and date in brackets. Cite meetings by title and date, and include [mm:ss] timestamps when you quote a moment. If the answer is not in the excerpts, say you could not find it. Be concise; use short bullet lists for multiple items.'
      : 'You answer questions about one meeting using only its notes and transcript. Quote or reference [mm:ss] timestamps for the moments you rely on. If something was not discussed, say so. You can also draft emails, recaps, or lists from the meeting when asked. Be concise.';
    const answer = await respond(key, {
      model: NOTES_MODEL,
      instructions,
      input: [{ role: 'developer', content: `Meeting material:\n${String(context).slice(0, 380000)}` }, ...clean]
    });
    return json(request, { answer });
  } catch (error) {
    return json(request, { error: error.message || 'Chat failed.' }, error.status && error.status < 600 ? error.status : 500);
  }
}
export const OPTIONS = options;
