import { db } from "./db";
import { newMeeting, store, uid } from "./store";
import type { Meeting, Segment } from "./types";

// Reads the previous version's data (left untouched) and copies it in once.
const OLD_KEY = "meeting-notes-v1";
const OLD_DB = "said-and-done-recordings";

type OldRecording = { id: string; mimeType: string; startedAt: string; duration: number; blob: Blob };

function readOldRecordings(): Promise<OldRecording[]> {
  return new Promise((resolve) => {
    let req: IDBOpenDBRequest;
    try {
      req = indexedDB.open(OLD_DB);
    } catch {
      return resolve([]);
    }
    req.onupgradeneeded = () => {
      // Didn't exist: abort creating an empty database.
      req.transaction?.abort();
    };
    req.onerror = () => resolve([]);
    req.onsuccess = async () => {
      const d = req.result;
      if (!d.objectStoreNames.contains("sessions") || !d.objectStoreNames.contains("chunks")) {
        d.close();
        return resolve([]);
      }
      const all = <T,>(r: IDBRequest<T>) =>
        new Promise<T>((ok, bad) => {
          r.onsuccess = () => ok(r.result);
          r.onerror = () => bad(r.error);
        });
      try {
        const sessions: any[] = await all(d.transaction("sessions").objectStore("sessions").getAll());
        const out: OldRecording[] = [];
        for (const s of sessions) {
          const rows: any[] = await all(d.transaction("chunks").objectStore("chunks").index("by-recording").getAll(s.id));
          rows.sort((a, b) => a.sequence - b.sequence);
          const blob = new Blob(rows.map((r) => r.data || r.blob).filter(Boolean), { type: s.mimeType || "audio/mp4" });
          if (blob.size) out.push({ id: s.id, mimeType: s.mimeType, startedAt: s.startedAt, duration: s.duration || 0, blob });
        }
        d.close();
        resolve(out);
      } catch {
        d.close();
        resolve([]);
      }
    };
  });
}

const PLACEHOLDER = /^(processing audio…|recording recovered\.|transcription queued safely)/i;

export async function migrateOldData(): Promise<number> {
  if (await db.kv("migrated-v1")) return 0;
  let old: any[] = [];
  try {
    old = JSON.parse(localStorage.getItem(OLD_KEY) || "[]");
  } catch {
    old = [];
  }
  const recordings = await readOldRecordings();
  const byId = new Map(recordings.map((r) => [r.id, r]));
  const used = new Set<string>();
  let count = 0;

  for (const o of Array.isArray(old) ? old : []) {
    if (!o || o.id === "welcome") continue;
    const rec = byId.get(o.localRecordingId || o.id);
    const hasTranscript = o.transcript && !PLACEHOLDER.test(String(o.transcript).trim());
    if (o.status === "planned" && !hasTranscript && !rec) continue;
    const speakers: Record<string, string> = {};
    const idFor = new Map<string, string>();
    const sid = (label: string) => {
      if (!idFor.has(label)) {
        const id = `S${idFor.size + 1}`;
        idFor.set(label, id);
        speakers[id] = (o.speakerNames?.[label] || label || `Speaker ${idFor.size}`).replace(/_/g, " ");
      }
      return idFor.get(label)!;
    };
    let segments: Segment[] = [];
    if (Array.isArray(o.transcriptSegments) && o.transcriptSegments.length) {
      segments = o.transcriptSegments.map((s: any) => ({
        id: uid(),
        speaker: sid(String(s.speaker || "Speaker")),
        text: String(s.text || ""),
        start: Number(s.start) || 0,
        end: Number(s.end) || 0,
      }));
    } else if (hasTranscript) {
      segments = String(o.transcript)
        .split(/\n{2,}/)
        .map((p: string) => p.trim())
        .filter(Boolean)
        .map((p: string) => {
          const m = p.match(/^\[(\d+):(\d{2})\]\s*([^:]{1,40}):\s*([\s\S]*)$/);
          return m
            ? { id: uid(), speaker: sid(m[3]), text: m[4], start: +m[1] * 60 + +m[2], end: +m[1] * 60 + +m[2] }
            : { id: uid(), speaker: sid("Speaker 1"), text: p, start: 0, end: 0 };
        });
    }
    const summaryOk = o.summary && !/will appear after transcription|recovered from continuous|creating ai meeting notes/i.test(o.summary);
    const actions = (o.actions || []).map((task: string, i: number) => ({
      id: uid(),
      task,
      owner: o.actionDetails?.[i]?.owner || null,
      due: o.actionDetails?.[i]?.due || null,
      start: null,
      done: !!o.completed?.[i],
    }));
    const m: Meeting = newMeeting({
      id: uid(),
      title: o.title || "Untitled meeting",
      titleIsAuto: !o.title || /^(meeting|recovered meeting)\b/i.test(o.title),
      createdAt: o.date || new Date().toISOString(),
      duration: o.duration || rec?.duration || 0,
      status: segments.length ? "ready" : rec ? "needs_audio_processing" : "ready",
      segments,
      speakers,
      notes:
        summaryOk || actions.length
          ? {
              summary: summaryOk ? o.summary : "",
              outline: [],
              actions,
              decisions: o.decisions || [],
              keyPoints: o.keyPoints || [],
              openQuestions: o.openQuestions || [],
              topics: o.topics || [],
              generatedAt: o.updatedAt || o.date || new Date().toISOString(),
            }
          : undefined,
      userNotes: [o.agenda && `Agenda: ${o.agenda}`, o.attendees && `Attendees: ${o.attendees}`, o.notes]
        .filter(Boolean)
        .join("\n\n"),
      tags: o.tags || [],
      starred: !!o.favorite,
      hasPcm: false,
      source: "migrated",
      chat: o.chat || [],
    });
    if (rec) {
      used.add(rec.id);
      const key = `${m.id}:original`;
      await db.saveAudio(key, await rec.blob.arrayBuffer(), rec.mimeType || "audio/mp4");
      m.audioFiles = [{ name: `recording.${(rec.mimeType || "").includes("webm") ? "webm" : "m4a"}`, type: rec.mimeType, key }];
    }
    await store.add(m);
    count++;
  }

  // Recordings that never got a meeting entry.
  for (const rec of recordings.filter((r) => !used.has(r.id))) {
    const m = newMeeting({
      title: `Recovered recording · ${new Date(rec.startedAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })}`,
      createdAt: rec.startedAt,
      duration: rec.duration,
      status: "needs_audio_processing",
      hasPcm: false,
      source: "migrated",
    });
    const key = `${m.id}:original`;
    await db.saveAudio(key, await rec.blob.arrayBuffer(), rec.mimeType || "audio/mp4");
    m.audioFiles = [{ name: "recording.m4a", type: rec.mimeType, key }];
    await store.add(m);
    count++;
  }
  await db.setKv("migrated-v1", { at: new Date().toISOString(), count });
  return count;
}
