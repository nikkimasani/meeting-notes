import { json, options } from './_lib/http.js';
import { respond, NOTES_MODEL } from './_lib/openai.js';

const schema = {
  type: 'object', additionalProperties: false,
  properties: { subject: { type: 'string' }, body: { type: 'string' } },
  required: ['subject', 'body']
};

export async function POST(request) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return json(request, { error: 'AI service is not configured.' }, 503);
  try {
    const { context = '', tone = 'friendly' } = await request.json();
    if (!String(context).trim()) return json(request, { error: 'There is nothing to write a follow-up from yet.' }, 400);
    const text = await respond(key, {
      model: NOTES_MODEL,
      instructions: [
        'Write the follow-up email the meeting organizer would send to the other attendees after this meeting.',
        `Tone: ${String(tone).slice(0, 40)}, professional, plain language.`,
        'Body: a one-line thank-you, a 2-3 sentence recap, then short sections "Decisions", "Next steps" (owner and due date when known) and "Open questions" only when they have content. End with a short sign-off without a name.',
        'Use only facts from the meeting material. Do not invent dates, owners or numbers. Plain text, no markdown headings; use "- " bullets.'
      ].join(' '),
      input: `Meeting material:\n${String(context).slice(0, 200000)}`,
      text: { format: { type: 'json_schema', name: 'followup_email', strict: true, schema } }
    });
    return json(request, JSON.parse(text));
  } catch (error) {
    return json(request, { error: error.message || 'Could not draft the email.' }, error.status && error.status < 600 ? error.status : 500);
  }
}
export const OPTIONS = options;
