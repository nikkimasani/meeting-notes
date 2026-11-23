import { store, uid } from "./store";
import type { ChatMessage, Meeting, Notes } from "./types";

export const stamp = (sec: number) => {
  const s = Math.max(0, Math.floor(sec)),
    h = Math.floor(s / 3600),
    m = Math.floor((s % 3600) / 60),
    r = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${r}` : `${m}:${r}`;
};

export const speakerName = (m: Meeting, id: string) =>
  m.speakers[id] || (id.startsWith("S") ? `Speaker ${id.slice(1)}` : id);

export function transcriptText(m: Meeting, withStamps = true) {
  return m.segments
    .map((s) => `${withStamps ? `[${stamp(s.start)}] ` : ""}${speakerName(m, s.speaker)}: ${s.text}`)
    .join("\n");
}

const notesInFlight = new Set<string>();
export const isGeneratingNotes = (id: string) => notesInFlight.has(id);

export async function generateNotes(meetingId: string) {
  const m = store.get(meetingId);
  if (!m || notesInFlight.has(meetingId)) return;
  if (!m.segments.length) {
    store.update(meetingId, { notesError: "There is no transcript to summarize yet." });
    return;
  }
  notesInFlight.add(meetingId);
  store.update(meetingId, { notesError: undefined });
  try {
    const res = await fetch("/api/notes", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        transcript: transcriptText(m),
        title: m.titleIsAuto ? "" : m.title,
        speakers: [...new Set(m.segments.map((s) => speakerName(m, s.speaker)))],
        today: new Date().toDateString(),
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Could not create notes (${res.status}).`);
    const previous = store.get(meetingId)?.notes;
    const notes: Notes = {
      summary: String(data.summary || ""),
      outline: Array.isArray(data.outline) ? data.outline : [],
      actions: (Array.isArray(data.action_items) ? data.action_items : []).map((a: any) => ({
        id: uid(),
        task: String(a.task || ""),
        owner: a.owner || null,
        due: a.due || null,
        start: typeof a.start === "number" ? a.start : null,
        done: !!previous?.actions.find((p) => p.task === a.task)?.done,
      })),
      decisions: data.decisions || [],
      keyPoints: data.key_points || [],
      openQuestions: data.open_questions || [],
      topics: data.topics || [],
      sentiment:
        data.sentiment && typeof data.sentiment.positive === "number"
          ? {
              positive: Math.round(data.sentiment.positive),
              neutral: Math.round(data.sentiment.neutral),
              negative: Math.round(data.sentiment.negative),
              tone: String(data.sentiment.tone || ""),
            }
          : undefined,
      generatedAt: new Date().toISOString(),
    };
    const latest = store.get(meetingId)!;
    store.update(meetingId, {
      notes,
      ...(latest.titleIsAuto && data.title ? { title: String(data.title), titleIsAuto: false } : {}),
      tags: latest.tags.length ? latest.tags : notes.topics.slice(0, 3),
    });
  } catch (e: any) {
    store.update(meetingId, { notesError: e.message || "Could not create notes." });
  } finally {
    notesInFlight.delete(meetingId);
  }
}

async function chatRequest(messages: ChatMessage[], context: string, scope: "meeting" | "library") {
  const res = await fetch("/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ messages: messages.map(({ role, content }) => ({ role, content })), context, scope }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Chat failed (${res.status}).`);
  return String(data.answer || "");
}

export function meetingContext(m: Meeting) {
  const n = m.notes;
  return [
    `Title: ${m.title}`,
    `Date: ${new Date(m.createdAt).toLocaleString()}`,
    n?.summary && `Summary: ${n.summary}`,
    n?.actions.length && `Action items:\n${n.actions.map((a) => `- ${a.task}${a.owner ? ` (${a.owner})` : ""}`).join("\n")}`,
    m.userNotes && `Personal notes:\n${m.userNotes}`,
    `Transcript:\n${transcriptText(m)}`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

export async function askMeeting(meetingId: string, question: string) {
  const m = store.get(meetingId);
  if (!m) return;
  const user: ChatMessage = { role: "user", content: question, at: new Date().toISOString() };
  store.update(meetingId, { chat: [...m.chat, user] });
  try {
    const answer = await chatRequest([...m.chat, user], meetingContext(m), "meeting");
    store.update(meetingId, (x) => ({
      chat: [...x.chat, { role: "assistant", content: answer, at: new Date().toISOString() }],
    }));
  } catch (e: any) {
    store.update(meetingId, (x) => ({
      chat: [...x.chat, { role: "assistant", content: `⚠︎ ${e.message}`, at: new Date().toISOString() }],
    }));
  }
}

/** Picks the most relevant meetings and lines for a question across the library. */
export function libraryContext(meetings: Meeting[], question: string, budget = 150_000) {
  const words = question
    .toLowerCase()
    .split(/[^a-z0-9']+/)
    .filter((w) => w.length > 2 && !STOP.has(w));
  const scored = meetings
    .filter((m) => m.segments.length || m.notes)
    .map((m) => {
      const hay = (m.title + " " + (m.notes?.summary || "") + " " + m.tags.join(" ")).toLowerCase();
      const body = transcriptText(m, false).toLowerCase();
      let score = 0;
      for (const w of words) {
        if (hay.includes(w)) score += 5;
        score += Math.min(10, body.split(w).length - 1);
      }
      const ageDays = (Date.now() - +new Date(m.createdAt)) / 864e5;
      score += Math.max(0, 3 - ageDays / 10);
      return { m, score };
    })
    .sort((a, b) => b.score - a.score);
  let out = "";
  for (const { m } of scored) {
    const head = `[${m.title} — ${new Date(m.createdAt).toLocaleDateString(undefined, { dateStyle: "medium" })}]`;
    const summary = m.notes?.summary ? `Summary: ${m.notes.summary}\n` : "";
    const actions = m.notes?.actions.length
      ? `Action items: ${m.notes.actions.map((a) => a.task + (a.owner ? ` (${a.owner})` : "")).join("; ")}\n`
      : "";
    const full = transcriptText(m);
    const lines = words.length
      ? m.segments
          .filter((s) => words.some((w) => s.text.toLowerCase().includes(w)))
          .slice(0, 40)
          .map((s) => `[${stamp(s.start)}] ${speakerName(m, s.speaker)}: ${s.text}`)
          .join("\n")
      : "";
    const block = `${head}\n${summary}${actions}${full.length < 12000 ? `Transcript:\n${full}` : lines ? `Relevant lines:\n${lines}` : ""}\n\n`;
    if (out.length + block.length > budget) {
      if (out.length + head.length + summary.length < budget) out += `${head}\n${summary}\n`;
      continue;
    }
    out += block;
  }
  return out;
}

export async function askLibrary(history: ChatMessage[], question: string, meetings: Meeting[]) {
  const user: ChatMessage = { role: "user", content: question, at: new Date().toISOString() };
  const answer = await chatRequest([...history, user], libraryContext(meetings, question), "library");
  return { user, assistant: { role: "assistant" as const, content: answer, at: new Date().toISOString() } };
}

const STOP = new Set(
  "the and for are but not you all any can had her was one our out day get has him his how man new now old see two way who boy did its let put say she too use what when where which with this that from they have will your about there their would could should into than then them these those been were said what's".split(
    " ",
  ),
);

const followupInFlight = new Set<string>();
export const isDraftingFollowup = (id: string) => followupInFlight.has(id);

/** Drafts the follow-up email the organizer would send after the meeting. */
export async function draftFollowup(meetingId: string) {
  const m = store.get(meetingId);
  if (!m || followupInFlight.has(meetingId)) return;
  followupInFlight.add(meetingId);
  store.update(meetingId, {});
  try {
    const res = await fetch("/api/followup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ context: meetingContext(m) }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Could not draft the email (${res.status}).`);
    store.update(meetingId, { followup: { subject: String(data.subject || m.title), body: String(data.body || ""), at: new Date().toISOString() } });
  } finally {
    followupInFlight.delete(meetingId);
    store.update(meetingId, {});
  }
}
