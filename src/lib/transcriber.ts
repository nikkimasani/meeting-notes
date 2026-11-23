import { db } from "./db";
import { store, uid } from "./store";
import { RATE, wavBlob, wavDataUrl } from "./audio";
import { generateNotes } from "./ai";
import type { Piece, Segment } from "./types";

type Ref = { id: string; dataUrl: string };
const MAX_ATTEMPTS = 6;
const BACKOFF = [0, 3, 8, 20, 45, 90];
const listeners = new Set<() => void>();
let running = false;
let timer: number | undefined;

export const transcriber = {
  kick() {
    if (!running) void loop();
  },
  onChange(fn: () => void) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
  /** Re-queues failed pieces for a meeting. */
  async retry(meetingId: string) {
    const pieces = await db.pieces(meetingId);
    for (const p of pieces.filter((p) => p.state === "failed"))
      await db.updatePiece({ ...p, state: "pending", attempts: 0, lastError: undefined });
    store.update(meetingId, { status: "processing", error: undefined });
    this.kick();
  },
  /** Called when capture/import has finished feeding pieces. */
  async finishIfDone(meetingId: string) {
    const m = store.get(meetingId);
    if (!m || m.status === "recording") return;
    const pieces = await db.pieces(meetingId);
    if (pieces.some((p) => p.state === "pending")) return;
    const failed = pieces.filter((p) => p.state === "failed");
    if (failed.length) {
      store.update(meetingId, {
        status: "error",
        error: `${failed.length} of ${pieces.length} parts could not be transcribed${failed[0].lastError ? `: ${failed[0].lastError}` : ""}. Your audio is saved — tap Retry.`,
      });
      return;
    }
    if (m.status === "processing") {
      store.update(meetingId, { status: "ready", error: undefined });
      if (m.segments.length) void generateNotes(meetingId);
      else store.update(meetingId, { notesError: "No speech was detected in this recording." });
    }
  },
};

const emit = () => listeners.forEach((l) => l());

async function loop() {
  running = true;
  try {
    for (;;) {
      if (!navigator.onLine) {
        await new Promise<void>((r) => window.addEventListener("online", () => r(), { once: true }));
        continue;
      }
      const pending = await db.pendingPieces();
      if (!pending.length) break;
      const now = Date.now();
      const ready = pending.find((p) => !p.notBefore || p.notBefore <= now);
      if (!ready) {
        const soonest = Math.min(...pending.map((p) => p.notBefore || now));
        await new Promise((r) => {
          timer = window.setTimeout(r, Math.max(500, soonest - now));
        });
        continue;
      }
      await processPiece(ready);
      emit();
    }
  } finally {
    running = false;
    window.clearTimeout(timer);
  }
}

async function processPiece(piece: Piece) {
  const meeting = store.get(piece.meetingId);
  const pcm = await db.pcm(piece.meetingId, piece.index);
  if (!meeting || !pcm) {
    await db.updatePiece({ ...piece, state: "failed", lastError: "Audio for this part is missing." });
    return;
  }
  const refs = ((await db.kv<Ref[]>("refs:" + piece.meetingId)) || []).slice(0, 4);
  const form = new FormData();
  form.append("audio", new File([wavBlob([pcm])], `part-${piece.index}.wav`, { type: "audio/wav" }));
  form.append("language", meeting.language || "auto");
  if (refs.length) {
    form.append("knownSpeakerNames", JSON.stringify(refs.map((r) => r.id)));
    form.append("knownSpeakerReferences", JSON.stringify(refs.map((r) => r.dataUrl)));
  }
  let data: any;
  try {
    const res = await fetch("/api/transcribe", { method: "POST", body: form });
    data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.error || `Server error ${res.status}`), { status: res.status });
  } catch (e: any) {
    const attempts = piece.attempts + 1;
    const permanent = e.status === 400 || e.status === 413;
    const next = {
      ...piece,
      attempts,
      lastError: e.message || "Network error",
      state: permanent || attempts >= MAX_ATTEMPTS ? ("failed" as const) : ("pending" as const),
      notBefore: Date.now() + (BACKOFF[attempts] || 90) * 1000,
    };
    await db.updatePiece(next);
    if (next.state === "failed") void transcriber.finishIfDone(piece.meetingId);
    return;
  }

  // Map the service's speaker labels onto stable ids for this meeting.
  const known = new Set(refs.map((r) => r.id));
  const current = store.get(piece.meetingId)!;
  const speakers = { ...current.speakers };
  const labelMap = new Map<string, string>();
  const nextId = () => `S${Object.keys(speakers).length + 1}`;
  const raw: { speaker: string; text: string; start: number; end: number }[] =
    Array.isArray(data.segments) && data.segments.length
      ? data.segments
      : String(data.text || data.transcript || "").trim()
        ? [{ speaker: "?", text: String(data.text || data.transcript).trim(), start: 0, end: piece.duration }]
        : [];
  const segments: Segment[] = [];
  for (const s of raw) {
    const text = String(s.text || "").trim();
    if (!text) continue;
    let id: string;
    if (known.has(s.speaker)) id = s.speaker;
    else if (s.speaker === "?") id = lastSpeaker(current.segments) || "S1";
    else {
      if (!labelMap.has(s.speaker)) {
        const fresh = Object.keys(speakers).length < 8 ? nextId() : lastSpeaker(current.segments) || "S1";
        labelMap.set(s.speaker, fresh);
      }
      id = labelMap.get(s.speaker)!;
    }
    if (!speakers[id]) speakers[id] = `Speaker ${id.slice(1)}`;
    segments.push({
      id: uid(),
      speaker: id,
      text,
      start: round(piece.start + (Number(s.start) || 0)),
      end: round(piece.start + (Number(s.end) || Number(s.start) || 0)),
    });
  }

  // Save a short voice sample for each new speaker so later parts keep the same label.
  if (refs.length < 4 && labelMap.size) {
    const updated = [...refs];
    for (const [label, id] of labelMap) {
      if (updated.length >= 4 || updated.some((r) => r.id === id)) continue;
      const theirs = raw
        .filter((s) => s.speaker === label)
        .map((s) => ({ start: Number(s.start) || 0, end: Number(s.end) || 0 }))
        .sort((a, b) => b.end - b.start - (a.end - a.start))[0];
      if (!theirs || theirs.end - theirs.start < 2) continue;
      const from = Math.floor(theirs.start * RATE);
      const to = Math.min(pcm.length, from + Math.floor(Math.min(8, theirs.end - theirs.start) * RATE));
      try {
        updated.push({ id, dataUrl: await wavDataUrl(pcm.slice(from, to)) });
      } catch {
        /* ignore */
      }
    }
    await db.setKv("refs:" + piece.meetingId, updated);
  }

  store.update(piece.meetingId, (m) => ({
    speakers: { ...speakers, ...m.speakers },
    segments: applyMarks(
      mergeAdjacent([...m.segments.filter((x) => x.start < piece.start || x.start >= piece.start + piece.duration), ...segments]),
      m.marks || [],
    ),
  }));
  await db.updatePiece({ ...piece, state: "done", attempts: piece.attempts + 1, lastError: undefined });
  await transcriber.finishIfDone(piece.meetingId);
}

/** Turns "highlight" taps made while recording into highlighted lines. */
export function applyMarks(segs: Segment[], marks: number[]) {
  if (!marks.length) return segs;
  return segs.map((s) =>
    !s.highlight && marks.some((t) => t >= s.start - 1 && t <= s.end + 4) ? { ...s, highlight: true } : s,
  );
}

const round = (n: number) => Math.round(n * 100) / 100;
const lastSpeaker = (segs: Segment[]) => segs[segs.length - 1]?.speaker;

/** Sort by time and join very short consecutive lines from the same speaker. */
function mergeAdjacent(list: Segment[]) {
  const sorted = list.sort((a, b) => a.start - b.start);
  const out: Segment[] = [];
  for (const s of sorted) {
    const prev = out[out.length - 1];
    if (
      prev &&
      prev.speaker === s.speaker &&
      !prev.highlight &&
      !s.highlight &&
      !prev.comment &&
      !s.comment &&
      s.start - prev.end < 1.5 &&
      prev.text.length + s.text.length < 420
    ) {
      out[out.length - 1] = { ...prev, text: prev.text + " " + s.text, end: s.end };
    } else out.push(s);
  }
  return out;
}

export async function pieceStats(meetingId: string) {
  const pieces = await db.pieces(meetingId);
  return {
    total: pieces.length,
    done: pieces.filter((p) => p.state === "done").length,
    failed: pieces.filter((p) => p.state === "failed").length,
    pending: pieces.filter((p) => p.state === "pending").length,
  };
}
