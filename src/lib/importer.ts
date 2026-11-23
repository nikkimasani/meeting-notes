import { db } from "./db";
import { newMeeting, store } from "./store";
import { RATE, decodeToPcm, peaksOf } from "./audio";
import { transcriber } from "./transcriber";

const PIECE = 30 * RATE;
const progress = new Map<string, number>();
const listeners = new Set<() => void>();
export const importProgress = {
  get: (id: string) => progress.get(id),
  subscribe: (fn: () => void) => {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
};
const setProgress = (id: string, v: number | undefined) => {
  if (v === undefined) progress.delete(id);
  else progress.set(id, v);
  listeners.forEach((l) => l());
};

/** Cuts decoded audio into 30 s pieces and queues them for transcription. */
async function feedPieces(meetingId: string, blob: Blob) {
  let buf: Int16Array[] = [];
  let len = 0;
  let index = 0;
  let start = 0;
  const peaks: number[] = [];
  const flush = async () => {
    if (!len) return;
    const data = new Int16Array(len);
    let o = 0;
    for (const b of buf) {
      data.set(b, o);
      o += b.length;
    }
    buf = [];
    len = 0;
    await db.savePiece({ meetingId, index: index++, start, duration: data.length / RATE, state: "pending", attempts: 0 }, data);
    start += data.length / RATE;
    transcriber.kick();
  };
  await decodeToPcm(
    blob,
    async (pcm) => {
      peaks.push(...peaksOf(pcm));
      let offset = 0;
      while (offset < pcm.length) {
        const take = Math.min(PIECE - len, pcm.length - offset);
        buf.push(pcm.subarray(offset, offset + take).slice());
        len += take;
        offset += take;
        if (len >= PIECE) await flush();
      }
    },
    (f) => setProgress(meetingId, f),
  );
  await flush();
  store.update(meetingId, { peaks, duration: start, hasPcm: true });
}

export async function importFile(file: File) {
  const m = newMeeting({
    title: file.name.replace(/\.[^.]+$/, ""),
    titleIsAuto: true,
    status: "processing",
    source: "import",
    createdAt: new Date(file.lastModified || Date.now()).toISOString(),
    hasPcm: false,
  });
  const key = `${m.id}:original`;
  await store.add({ ...m, audioFiles: [{ name: file.name, type: file.type || "audio/mpeg", key }] });
  try {
    await db.saveAudio(key, await file.arrayBuffer(), file.type || "audio/mpeg");
  } catch {
    /* storage full: still transcribe */
  }
  void runDecode(m.id, file);
  return m.id;
}

/** Transcribes audio that was imported or migrated but never processed. */
export async function processStoredAudio(meetingId: string) {
  const m = store.get(meetingId);
  const file = m?.audioFiles[0];
  if (!m || !file) return;
  const blob = (await db.audio(file.key)) || (await db.chunkedAudio(file.key));
  if (!blob) {
    store.update(meetingId, { status: "error", error: "The audio for this meeting is no longer on this device." });
    return;
  }
  store.update(meetingId, { status: "processing", error: undefined, segments: [] });
  void runDecode(meetingId, blob);
}

async function runDecode(meetingId: string, blob: Blob) {
  setProgress(meetingId, 0);
  try {
    await feedPieces(meetingId, blob);
    await transcriber.finishIfDone(meetingId);
  } catch (e: any) {
    store.update(meetingId, { status: "error", error: e.message || "This audio could not be read." });
  } finally {
    setProgress(meetingId, undefined);
  }
}
