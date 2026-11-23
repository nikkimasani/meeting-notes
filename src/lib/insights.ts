import type { Meeting, Segment } from "./types";
import { speakerName } from "./ai";

export type TalkStat = { id: string; name: string; sec: number; words: number; pct: number; questions: number };

const wordsIn = (t: string) => (t.trim() ? t.trim().split(/\s+/).length : 0);

/** Talk time per speaker, largest first. */
export function talkTime(m: Meeting): TalkStat[] {
  const by = new Map<string, TalkStat>();
  for (const s of m.segments) {
    const t = by.get(s.speaker) || { id: s.speaker, name: speakerName(m, s.speaker), sec: 0, words: 0, pct: 0, questions: 0 };
    t.sec += Math.max(0, s.end - s.start);
    t.words += wordsIn(s.text);
    t.questions += (s.text.match(/\?/g) || []).length;
    by.set(s.speaker, t);
  }
  const list = [...by.values()];
  const total = list.reduce((n, t) => n + t.sec, 0) || 1;
  // Round so the shares add up to exactly 100.
  let used = 0;
  list.sort((a, b) => b.sec - a.sec);
  list.forEach((t, i) => {
    t.pct = i === list.length - 1 ? Math.max(0, 100 - used) : Math.round((t.sec / total) * 100);
    used += t.pct;
  });
  return list;
}

/** Where each speaker talks, as fractions of the meeting, for the call-flow lanes. */
export function lanes(m: Meeting) {
  const dur = Math.max(m.duration, m.segments[m.segments.length - 1]?.end || 0, 1);
  const out = new Map<string, { from: number; to: number }[]>();
  for (const s of m.segments) {
    const list = out.get(s.speaker) || [];
    const from = s.start / dur,
      to = Math.max(s.end, s.start + 0.5) / dur;
    const last = list[list.length - 1];
    if (last && from - last.to < 0.004) last.to = to;
    else list.push({ from, to });
    out.set(s.speaker, list);
  }
  return out;
}

const DAYS = "monday|tuesday|wednesday|thursday|friday|saturday|sunday";
const MONTHS = "january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sept|sep|oct|nov|dec";

export type SmartFilter = { key: string; label: string; test: (s: Segment) => RegExp | null };

const rx = (re: RegExp) => (s: Segment) => (re.test(s.text) ? re : null);

export const SMART_FILTERS: SmartFilter[] = [
  { key: "questions", label: "Questions", test: rx(/[^.?!]*\?/) },
  {
    key: "commitments",
    label: "Commitments",
    test: rx(/\b(i'll|i will|we'll|we will|i can (do|send|take)|let me|i'm going to|can you|could you|will you|follow up|send (it|you|over|that)|circle back|get back to)\b/i),
  },
  {
    key: "decisions",
    label: "Decisions",
    test: rx(/\b(decided|decision|we'll go with|let's go with|let's do|agreed|agree on|final(ly|ize)?|we're going (to|with)|the plan is|sign(ed)? off|approved?)\b/i),
  },
  {
    key: "dates",
    label: "Dates & times",
    test: rx(
      new RegExp(
        `\\b(${DAYS}|today|tomorrow|tonight|yesterday|next (week|month|quarter|year)|this (week|month|quarter|friday|monday)|end of (the )?(day|week|month|quarter|year)|eod|eow|q[1-4]|${MONTHS})\\b|\\b\\d{1,2}(:\\d{2})?\\s?(am|pm)\\b|\\b\\d{1,2}/\\d{1,2}\\b`,
        "i",
      ),
    ),
  },
  {
    key: "numbers",
    label: "Numbers & metrics",
    test: rx(/(\$\s?\d[\d,.]*|\b\d[\d,.]*\s?(%|percent|k\b|m\b|million|billion|thousand|dollars|bucks|users|customers|hours|minutes|days|weeks|months|x\b))|\b\d{3,}\b/i),
  },
  {
    key: "pricing",
    label: "Pricing & budget",
    test: rx(/\b(price|pricing|cost|costs|budget|spend|invoice|discount|quote|fee|fees|contract|renewal|paid|pay|revenue|roi)\b/i),
  },
  {
    key: "concerns",
    label: "Risks & concerns",
    test: rx(/\b(worried|worry|concern(ed|s)?|risk(y|s)?|problem|issue|blocker|blocked|not sure|unclear|tricky|delay(ed)?|behind|challenge|struggl\w*)\b/i),
  },
];

export function filterMatches(m: Meeting, f: SmartFilter) {
  return m.segments.filter((s) => f.test(s));
}

export function stats(m: Meeting) {
  const words = m.segments.reduce((n, s) => n + wordsIn(s.text), 0);
  const talkSec = m.segments.reduce((n, s) => n + Math.max(0, s.end - s.start), 0);
  let longest = { speaker: "", sec: 0, start: 0 };
  let run = { speaker: "", sec: 0, start: 0, end: 0 };
  let switches = 0;
  for (const s of m.segments) {
    if (s.speaker === run.speaker && s.start - run.end < 4) {
      run.sec += s.end - s.start;
      run.end = s.end;
    } else {
      if (run.speaker) switches++;
      run = { speaker: s.speaker, sec: s.end - s.start, start: s.start, end: s.end };
    }
    if (run.sec > longest.sec) longest = { speaker: run.speaker, sec: run.sec, start: run.start };
  }
  const questions = m.segments.reduce((n, s) => n + (s.text.match(/\?/g) || []).length, 0);
  return {
    words,
    wpm: talkSec > 20 ? Math.round(words / (talkSec / 60)) : 0,
    longest,
    switches,
    questions,
  };
}
