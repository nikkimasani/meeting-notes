export const RATE = 16000;

export function wavHeader(byteLength: number, rate = RATE) {
  const header = new ArrayBuffer(44);
  const v = new DataView(header);
  const w = (o: number, s: string) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  w(0, "RIFF");
  v.setUint32(4, 36 + byteLength, true);
  w(8, "WAVE");
  w(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  w(36, "data");
  v.setUint32(40, byteLength, true);
  return header;
}

/** Builds a WAV Blob from PCM parts without copying them. */
export function wavBlob(parts: (ArrayBuffer | Int16Array)[]) {
  const bytes = parts.reduce((n, p) => n + p.byteLength, 0);
  return new Blob([wavHeader(bytes), ...parts.map((p) => (p instanceof Int16Array ? p.slice().buffer : p))], {
    type: "audio/wav",
  });
}

export async function wavDataUrl(pcm: Int16Array) {
  const blob = wavBlob([pcm]);
  return await new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

export function peaksOf(pcm: Int16Array, perSecond = 10) {
  const size = Math.max(1, Math.floor(RATE / perSecond));
  const out: number[] = [];
  for (let i = 0; i < pcm.length; i += size) {
    let max = 0;
    const end = Math.min(pcm.length, i + size);
    for (let j = i; j < end; j += 4) {
      const a = Math.abs(pcm[j]);
      if (a > max) max = a;
    }
    out.push(Math.round(Math.min(1, Math.sqrt(max / 32768) * 1.15) * 100) / 100);
  }
  return out;
}

export function floatTo16(input: Float32Array) {
  const out = new Int16Array(input.length);
  for (let i = 0; i < input.length; i++) {
    const s = Math.max(-1, Math.min(1, input[i]));
    out[i] = s < 0 ? s * 32768 : s * 32767;
  }
  return out;
}

// ---------- Decoding imported / legacy files to 16 kHz mono ----------

const boxType = (b: Uint8Array, at: number) =>
  String.fromCharCode(b[at + 4], b[at + 5], b[at + 6], b[at + 7]);

// iOS MediaRecorder writes fragmented MP4. Safari's decodeAudioData only reads
// the first fragment, so we split init + fragments and decode each one.
function splitFragmentedMp4(bytes: Uint8Array) {
  if (bytes.length < 8 || boxType(bytes, 0) !== "ftyp") return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const fragments: { init: Uint8Array; start: number; end: number }[] = [];
  let initStart = 0,
    init: Uint8Array | null = null,
    fragStart = -1,
    at = 0;
  const close = (end: number) => {
    if (fragStart >= 0 && init) fragments.push({ init, start: fragStart, end });
    fragStart = -1;
  };
  while (at + 8 <= bytes.length) {
    let size = view.getUint32(at);
    const type = boxType(bytes, at);
    if (size === 1 && at + 16 <= bytes.length) size = Number(view.getBigUint64(at + 8));
    else if (size === 0) size = bytes.length - at;
    if (size < 8) break;
    if (type === "ftyp") {
      close(at);
      initStart = at;
      init = null;
    } else if (type === "moof") {
      close(at);
      if (!init) init = bytes.subarray(initStart, at);
      fragStart = at;
    }
    at += size;
  }
  close(Math.min(at, bytes.length));
  return fragments.length > 1 ? fragments : null;
}

function zeroTfdt(piece: Uint8Array, moofAt: number) {
  const v = new DataView(piece.buffer, piece.byteOffset, piece.byteLength);
  const walk = (start: number, end: number) => {
    let at = start;
    while (at + 8 <= end) {
      const size = v.getUint32(at),
        type = boxType(piece, at);
      if (size < 8 || at + size > end) return;
      if (type === "traf") walk(at + 8, at + size);
      else if (type === "tfdt") {
        if (piece[at + 8] === 1) v.setBigUint64(at + 12, 0n);
        else v.setUint32(at + 12, 0);
      }
      at += size;
    }
  };
  walk(moofAt + 8, moofAt + v.getUint32(moofAt));
}

function toMono16k(buf: AudioBuffer): Int16Array {
  const ratio = buf.sampleRate / RATE;
  const frames = Math.floor(buf.length / ratio);
  const chans = Array.from({ length: buf.numberOfChannels }, (_, c) => buf.getChannelData(c));
  const out = new Int16Array(frames);
  for (let i = 0; i < frames; i++) {
    const src = Math.min(buf.length - 1, Math.floor(i * ratio));
    let s = 0;
    for (const ch of chans) s += ch[src];
    s = Math.max(-1, Math.min(1, s / chans.length));
    out[i] = s < 0 ? s * 32768 : s * 32767;
  }
  return out;
}

/**
 * Decodes any browser-playable audio/video file into 16 kHz mono PCM, calling
 * onChunk with consecutive pieces so long files never sit in memory at once.
 */
export async function decodeToPcm(
  blob: Blob,
  onChunk: (pcm: Int16Array) => Promise<void> | void,
  onProgress?: (fraction: number) => void,
) {
  let ctx: BaseAudioContext;
  try {
    ctx = new OfflineAudioContext(1, 1, RATE);
  } catch {
    ctx = new AudioContext();
  }
  const decode = (data: ArrayBuffer) => ctx.decodeAudioData(data);
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const fragments = splitFragmentedMp4(bytes);
  let decodedAny = false;
  try {
    if (fragments) {
      for (let i = 0; i < fragments.length; i++) {
        const { init, start, end } = fragments[i];
        const piece = new Uint8Array(init.length + (end - start));
        piece.set(init, 0);
        piece.set(bytes.subarray(start, end), init.length);
        zeroTfdt(piece, init.length);
        try {
          await onChunk(toMono16k(await decode(piece.buffer)));
          decodedAny = true;
        } catch {
          /* skip a damaged fragment, e.g. the last one after a crash */
        }
        if (i % 12 === 0) onProgress?.(i / fragments.length);
      }
    } else {
      const decoded = await decode(bytes.buffer.slice(0));
      const pcm = toMono16k(decoded);
      const step = RATE * 60;
      for (let i = 0; i < pcm.length; i += step) {
        await onChunk(pcm.subarray(i, Math.min(pcm.length, i + step)).slice());
        onProgress?.(i / pcm.length);
      }
      decodedAny = pcm.length > 0;
    }
  } finally {
    if ("close" in ctx) void (ctx as AudioContext).close();
  }
  if (!decodedAny) throw new Error("This file's audio could not be read on this device.");
  onProgress?.(1);
}
