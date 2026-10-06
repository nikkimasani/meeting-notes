const DB_NAME = 'said-and-done-recordings';
const DB_VERSION = 1;
const SESSION_STORE = 'sessions';
const CHUNK_STORE = 'chunks';

export type StoredRecording = {
  id: string;
  mimeType: string;
  startedAt: string;
  duration: number;
  status: 'recording' | 'complete';
  blob: Blob;
};

type RecordingSession = Omit<StoredRecording, 'blob'>;

function request<T>(value: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    value.onsuccess = () => resolve(value.result);
    value.onerror = () => reject(value.error || new Error('Recording storage failed.'));
  });
}

function transactionComplete(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error || new Error('Recording storage failed.'));
    transaction.onabort = () => reject(transaction.error || new Error('Recording storage was interrupted.'));
  });
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const opening = indexedDB.open(DB_NAME, DB_VERSION);
    opening.onupgradeneeded = () => {
      const database = opening.result;
      if (!database.objectStoreNames.contains(SESSION_STORE)) {
        database.createObjectStore(SESSION_STORE, { keyPath: 'id' });
      }
      if (!database.objectStoreNames.contains(CHUNK_STORE)) {
        const chunks = database.createObjectStore(CHUNK_STORE, { keyPath: ['recordingId', 'sequence'] });
        chunks.createIndex('by-recording', 'recordingId');
      }
    };
    opening.onsuccess = () => resolve(opening.result);
    opening.onerror = () => reject(opening.error || new Error('Unable to open recording storage.'));
  });
}

export async function beginRecording(id: string, mimeType: string): Promise<void> {
  const database = await openDatabase();
  const transaction = database.transaction(SESSION_STORE, 'readwrite');
  transaction.objectStore(SESSION_STORE).put({
    id,
    mimeType,
    startedAt: new Date().toISOString(),
    duration: 0,
    status: 'recording',
  } satisfies RecordingSession);
  await transactionComplete(transaction);
  database.close();
}

export async function appendRecordingChunk(recordingId: string, sequence: number, blob: Blob): Promise<void> {
  const data = await blob.arrayBuffer();
  const database = await openDatabase();
  const transaction = database.transaction(CHUNK_STORE, 'readwrite');
  transaction.objectStore(CHUNK_STORE).put({ recordingId, sequence, data, type: blob.type });
  await transactionComplete(transaction);
  database.close();
}

export async function completeRecording(id: string, duration: number): Promise<void> {
  const database = await openDatabase();
  const transaction = database.transaction(SESSION_STORE, 'readwrite');
  const store = transaction.objectStore(SESSION_STORE);
  const session = await request<RecordingSession | undefined>(store.get(id));
  if (session) store.put({ ...session, duration, status: 'complete' } satisfies RecordingSession);
  await transactionComplete(transaction);
  database.close();
}

async function readBlob(database: IDBDatabase, session: RecordingSession): Promise<Blob> {
  const transaction = database.transaction(CHUNK_STORE, 'readonly');
  const index = transaction.objectStore(CHUNK_STORE).index('by-recording');
  const rows = await request<Array<{ recordingId: string; sequence: number; data?: ArrayBuffer; blob?: Blob; type?: string }>>(index.getAll(session.id));
  rows.sort((a, b) => a.sequence - b.sequence);
  return new Blob(rows.map(row => row.data || row.blob).filter((part): part is ArrayBuffer | Blob => !!part), { type: session.mimeType || rows[0]?.type || rows[0]?.blob?.type || 'audio/webm' });
}

export async function getRecording(id: string): Promise<StoredRecording | null> {
  const database = await openDatabase();
  const transaction = database.transaction(SESSION_STORE, 'readonly');
  const session = await request<RecordingSession | undefined>(transaction.objectStore(SESSION_STORE).get(id));
  if (!session) {
    database.close();
    return null;
  }
  const blob = await readBlob(database, session);
  database.close();
  return { ...session, blob };
}

export async function listRecordings(): Promise<StoredRecording[]> {
  const database = await openDatabase();
  const transaction = database.transaction(SESSION_STORE, 'readonly');
  const sessions = await request<RecordingSession[]>(transaction.objectStore(SESSION_STORE).getAll());
  const recordings = await Promise.all(sessions.map(async session => ({ ...session, blob: await readBlob(database, session) })));
  database.close();
  return recordings.filter(recording => recording.blob.size > 0);
}
