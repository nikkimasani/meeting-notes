import { json, options } from './_lib/http.js';
import { respond, NOTES_MODEL } from './_lib/openai.js';

const list = { type: 'array', items: { type: 'string' } };
const schema = {
  type: 'object', additionalProperties: false,
  properties: {
    title: { type: 'string' },
    summary: { type: 'string' },
    outline: { type: 'array', items: { type: 'object', additionalProperties: false, properties: {
      heading: { type: 'string' }, start: { type: 'number' }, bullets: list
    }, required: ['heading', 'start', 'bullets'] } },
    action_items: { type: 'array', items: { type: 'object', additionalProperties: false, properties: {
      task: { type: 'string' }, owner: { type: ['string', 'null'] }, due: { type: ['string', 'null'] }, start: { type: ['number', 'null'] }
    }, required: ['task', 'owner', 'due', 'start'] } },
    decisions: list,
    key_points: list,
    open_questions: list,
    topics: list,
    sentiment: { type: 'object', additionalProperties: false, properties: {
      positive: { type: 'number' }, neutral: { type: 'number' }, negative: { type: 'number' }, tone: { type: 'string' }
    }, required: ['positive', 'neutral', 'negative', 'tone'] }
  },
  required: ['title', 'summary', 'outline', 'action_items', 'decisions', 'key_points', 'open_questions', 'topics', 'sentiment']
};

export async function POST(request) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return json(request, { error: 'AI service is not configured.' }, 503);
  try {
    const { transcript, title = '', speakers = [], today = '' } = await request.json();
    if (!String(transcript || '').trim()) return json(request, { error: 'A transcript is required.' }, 400);
    if (transcript.length > 400000) return json(request, { error: 'This transcript is too long to summarize in one pass.' }, 413);
    const text = await respond(key, {
      model: NOTES_MODEL,
      instructions: [
        'You write meeting notes in the style of Otter.ai: a short summary paragraph, then an outline of the conversation in chronological sections, then action items.',
        'Each transcript line starts with [mm:ss] or [h:mm:ss] and a speaker name. Outline "start" is the section start time in seconds, taken from those stamps.',
        'Write 3-8 outline sections for most meetings, each with a concrete heading (not "Introduction") and 1-4 short factual bullets that mention who said what when useful.',
        'Action items: only tasks someone committed to or was asked to do. Owner is a speaker or named person, or null. Due is the phrase used ("Friday", "next week") or an ISO date, else null. Start is the time in seconds where it was discussed.',
        'Title: a specific 3-7 word title for the meeting. If a title was supplied and is specific, keep it.',
        'Sentiment: estimate the share of the conversation that was positive, neutral and negative as whole-number percentages that add up to 100, and give the overall tone in 2-5 words (for example "Upbeat and decisive").',
        'Never invent facts. If the transcript is very short or empty of substance, say so plainly in the summary and leave lists empty.'
      ].join(' '),
      input: `Supplied title: ${title || '(none)'}\nToday: ${today}\nSpeakers: ${speakers.join(', ')}\n\nTranscript:\n${transcript}`,
      text: { format: { type: 'json_schema', name: 'meeting_notes', strict: true, schema } }
    });
    return json(request, JSON.parse(text));
  } catch (error) {
    return json(request, { error: error.message || 'Could not create notes.' }, error.status && error.status < 600 ? error.status : 500);
  }
}
export const OPTIONS = options;
