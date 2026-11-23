import type { Meeting, Piece } from "./types";

// One database for everything. ArrayBuffers (not Blobs) are stored because
// Safari has a long history of losing Blobs written to IndexedDB.
const DB_NAME = "said-and-done-v2";
const VERSION = 1;

let opening: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  if (opening) return opening;
  opening = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("meetings")) db.createObjectStore("meetings", { keyPath: "id" });
      if (!db.objectStoreNames.contains("pcm")) {
        const s = db.createObjectStore("pcm", { keyPath: ["meetingId", "index"] });
        s.createIndex("meeting", "meetingId");
      }
      if (!db.objectStoreNames.contains("pieces")) {
        const s = db.createObjectStore("pieces", { keyPath: ["meetingId", "index"] });
        s.createIndex("meeting", "meetingId");
        s.createIndex("state", "state");
      }
      if (!db.objectStoreNames.contains("audio")) db.createObjectStore("audio", { keyPath: "key" });
      if (!db.objectStoreNames.contains("kv")) db.createObjectStore("kv");
    };
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => db.close();
      db.onclose = () => (opening = null);
      resolve(db);
    };
    req.onerror = () => {
      opening = null;
      reject(req.error || new Error("Storage is unavailable."));
    };
  });
  return opening;
}

const done = (tx: IDBTransaction) =>
  new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error("Storage write failed."));
    tx.onabort = () => reject(tx.error || new Error("Storage write was interrupted."));
  });

const result = <T>(req: IDBRequest<T>) =>
  new Promise<T>((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

async function put(store: string, value: unknown, key?: IDBValidKey) {
  const db = await open();
  const tx = db.transaction(store, "readwrite");
  tx.objectStore(store).put(value, key);
  await done(tx);
}
async function get<T>(store: string, key: IDBValidKey): Promise<T | undefined> {
  const db = await open();
  return result(db.transaction(store).objectStore(store).get(key));
}
async function byMeeting<T>(store: string, meetingId: string): Promise<T[]> {
  const db = await open();
  return result(db.transaction(store).objectStore(store).index("meeting").getAll(meetingId));
}

export const db = {
  async meetings(): Promise<Meeting[]> {
    const d = await open();
    return result(d.transaction("meetings").objectStore("meetings").getAll());
  },
  meeting: (id: string) => get<Meeting>("meetings", id),
  saveMeeting: (m: Meeting) => put("meetings", m),
  async deleteMeeting(id: string) {
    const d = await open();
    const tx = d.transaction(["meetings", "pcm", "pieces", "audio", "kv"], "readwrite");
    tx.objectStore("meetings").delete(id);
    const range = IDBKeyRange.bound([id, 0], [id, Number.MAX_SAFE_INTEGER]);
    tx.objectStore("pcm").delete(range);
    tx.objectStore("pieces").delete(range);
    tx.objectStore("audio").delete(IDBKeyRange.bound(id + ":", id + ":￿"));
    tx.objectStore("kv").delete("refs:" + id);
    tx.objectStore("kv").delete(IDBKeyRange.bound(id + ":", id + ":￿"));
    await done(tx);
  },

  /** Saves a slice of PCM and its queue entry in one atomic write. */
  async savePiece(piece: Piece, pcm: Int16Array) {
    const d = await open();
    const tx = d.transaction(["pcm", "pieces"], "readwrite");
    tx.objectStore("pcm").put({ meetingId: piece.meetingId, index: piece.index, data: pcm.buffer.slice(0) });
    tx.objectStore("pieces").put(piece);
    await done(tx);
  },
  updatePiece: (piece: Piece) => put("pieces", piece),
  pieces: (meetingId: string) => byMeeting<Piece>("pieces", meetingId),
  async pendingPieces(): Promise<Piece[]> {
    const d = await open();
    const all: Piece[] = await result(d.transaction("pieces").objectStore("pieces").index("state").getAll("pending"));
    return all.sort((a, b) => (a.meetingId === b.meetingId ? a.index - b.index : 0));
  },
  async pcm(meetingId: string, index: number): Promise<Int16Array | null> {
    const row = await get<{ data: ArrayBuffer }>("pcm", [meetingId, index]);
    return row ? new Int16Array(row.data) : null;
  },
  async allPcm(meetingId: string): Promise<ArrayBuffer[]> {
    const rows = await byMeeting<{ index: number; data: ArrayBuffer }>("pcm", meetingId);
    return rows.sort((a, b) => a.index - b.index).map((r) => r.data);
  },

  saveAudio: (key: string, data: ArrayBuffer, type: string) => put("audio", { key, data, type }),
  async audio(key: string): Promise<Blob | null> {
    const row = await get<{ data: ArrayBuffer; type: string }>("audio", key);
    return row ? new Blob([row.data], { type: row.type }) : null;
  },
  async appendAudio(key: string, chunk: ArrayBuffer, type: string) {
    // Small (5 s) MediaRecorder chunks are stored under key#n so writes stay cheap.
    const d = await open();
    const tx = d.transaction("kv", "readwrite");
    const store = tx.objectStore("kv");
    const count = ((await result(store.get(key + "#count"))) as number) || 0;
    store.put({ data: chunk, type }, key + "#" + count);
    store.put(count + 1, key + "#count");
    await done(tx);
  },
  async chunkedAudio(key: string): Promise<Blob | null> {
    const d = await open();
    const store = d.transaction("kv").objectStore("kv");
    const count = ((await result(store.get(key + "#count"))) as number) || 0;
    if (!count) return null;
    const parts: { data: ArrayBuffer; type: string }[] = [];
    for (let i = 0; i < count; i++) {
      const p = await result(d.transaction("kv").objectStore("kv").get(key + "#" + i));
      if (p) parts.push(p as { data: ArrayBuffer; type: string });
    }
    return new Blob(parts.map((p) => p.data), { type: parts[0]?.type || "audio/mp4" });
  },

  kv: <T>(key: string) => get<T>("kv", key),
  setKv: (key: string, value: unknown) => put("kv", value, key),

  async estimate() {
    try {
      return await navigator.storage?.estimate?.();
    } catch {
      return undefined;
    }
  },
};

/** Ask the browser not to evict our data under storage pressure. */
export async function requestPersistence() {
  try {
    if (navigator.storage?.persisted && !(await navigator.storage.persisted()))
      await navigator.storage.persist?.();
  } catch {
    /* not supported */
  }
}
