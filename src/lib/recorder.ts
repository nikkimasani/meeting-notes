import { db } from "./db";
import { store } from "./store";
import { RATE, peaksOf } from "./audio";
import { transcriber } from "./transcriber";
import type { Meeting, Piece } from "./types";

const MIN_PIECE = 15 * RATE;
const MAX_PIECE = 35 * RATE;
const SILENCE_CUT = 0.35 * RATE;
const FRAME = 320; // 20 ms at 16 kHz

const WORKLET = `
class Tap extends AudioWorkletProcessor {
  constructor() { super(); this.buf = new Float32Array(2048); this.n = 0; }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) {
      for (let i = 0; i < ch.length; i++) {
        this.buf[this.n++] = ch[i];
        if (this.n === this.buf.length) { this.port.postMessage(this.buf.slice(0)); this.n = 0; }
      }
    }
    return true;
  }
}
registerProcessor('sd-tap', Tap);`;

export type RecorderState = "idle" | "starting" | "recording" | "paused" | "interrupted" | "stopping";

type Snapshot = { state: RecorderState; meetingId: string | null; elapsed: number; level: number; error: string };

class Recorder {
  snap: Snapshot = { state: "idle", meetingId: null, elapsed: 0, level: 0, error: "" };
  private listeners = new Set<() => void>();
  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private node: AudioWorkletNode | ScriptProcessorNode | null = null;
  private mr: MediaRecorder | null = null;
  private mrPart = 0;
  private wakeLock: any = null;
  // resampling
  private ratio = 3;
  private carry = new Float32Array(0);
  private pos = 0;
  // current piece
  private parts: Int16Array[] = [];
  private pieceLen = 0;
  private pieceIndex = 0;
  private committed = 0; // samples already in saved pieces
  private silenceRun = 0;
  private noiseFloor = 0.01;
  private frameAcc = new Float32Array(FRAME);
  private frameN = 0;
  private peakBuf: number[] = [];
  private lastCheckpoint = 0;
  private lastPeaksPush = 0;
  private tick: number | undefined;

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  getSnapshot = () => this.snap;
  private set(patch: Partial<Snapshot>) {
    this.snap = { ...this.snap, ...patch };
    this.listeners.forEach((l) => l());
  }

  get active() {
    return ["starting", "recording", "paused", "interrupted", "stopping"].includes(this.snap.state);
  }

  async start(meeting: Meeting) {
    if (this.active) throw new Error("A recording is already in progress.");
    this.set({ state: "starting", meetingId: meeting.id, elapsed: 0, level: 0, error: "" });
    this.parts = [];
    this.pieceLen = 0;
    this.pieceIndex = 0;
    this.committed = 0;
    this.silenceRun = 0;
    this.peakBuf = [];
    this.mrPart = 0;
    await store.add(meeting);
    try {
      await this.openInput(meeting.id);
      this.set({ state: "recording" });
      void this.lockScreen();
      document.addEventListener("visibilitychange", this.onVisibility);
      window.addEventListener("pagehide", this.onPageHide);
      this.tick = window.setInterval(() => this.onTick(), 250);
    } catch (e: any) {
      this.teardown();
      await store.remove(meeting.id);
      this.set({ state: "idle", meetingId: null, error: friendlyMicError(e) });
      throw new Error(friendlyMicError(e));
    }
  }

  private async openInput(meetingId: string) {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
    });
    const Ctx = window.AudioContext || (window as any).webkitAudioContext;
    this.ctx = this.ctx && this.ctx.state !== "closed" ? this.ctx : new Ctx();
    if (this.ctx.state === "suspended") await this.ctx.resume();
    this.ratio = this.ctx.sampleRate / RATE;
    this.carry = new Float32Array(0);
    this.pos = 0;
    this.source = this.ctx.createMediaStreamSource(this.stream);
    if (this.ctx.audioWorklet) {
      const url = URL.createObjectURL(new Blob([WORKLET], { type: "application/javascript" }));
      try {
        await this.ctx.audioWorklet.addModule(url);
      } catch {
        /* already registered */
      }
      const node = new AudioWorkletNode(this.ctx, "sd-tap");
      node.port.onmessage = (e) => this.onAudio(e.data as Float32Array);
      this.node = node;
    } else {
      const node = this.ctx.createScriptProcessor(4096, 1, 1);
      node.onaudioprocess = (e) => this.onAudio(new Float32Array(e.inputBuffer.getChannelData(0)));
      this.node = node;
    }
    // Route through a muted gain so the graph runs without echoing the mic.
    const mute = this.ctx.createGain();
    mute.gain.value = 0;
    this.source.connect(this.node);
    this.node.connect(mute).connect(this.ctx.destination);
    this.stream.getAudioTracks()[0]?.addEventListener("ended", this.onTrackEnded);
    this.startArchive(meetingId);
  }

  /** Compressed copy of the audio for export (the PCM is what we transcribe). */
  private startArchive(meetingId: string) {
    if (!this.stream || typeof MediaRecorder === "undefined") return;
    const type = ["audio/mp4", "audio/webm;codecs=opus", "audio/webm"].find((t) => MediaRecorder.isTypeSupported?.(t));
    if (!type) return;
    try {
      const mr = new MediaRecorder(this.stream, { mimeType: type, audioBitsPerSecond: 48000 });
      const key = `${meetingId}:rec${this.mrPart}`;
      const ext = type.includes("mp4") ? "m4a" : "webm";
      const name = this.mrPart ? `recording-part-${this.mrPart + 1}.${ext}` : `recording.${ext}`;
      store.update(meetingId, (m) => ({ audioFiles: [...m.audioFiles, { name, type: type.split(";")[0], key }] }));
      mr.ondataavailable = async (e) => {
        if (e.data.size) await db.appendAudio(key, await e.data.arrayBuffer(), type.split(";")[0]);
      };
      mr.start(5000);
      this.mr = mr;
      this.mrPart++;
    } catch {
      this.mr = null;
    }
  }

  private onAudio(input: Float32Array) {
    if (this.snap.state !== "recording") return;
    // Box-filter resample to 16 kHz, carrying the fractional position across buffers.
    const buf = new Float32Array(this.carry.length + input.length);
    buf.set(this.carry);
    buf.set(input, this.carry.length);
    const out: number[] = [];
    let pos = this.pos;
    while (pos + this.ratio <= buf.length) {
      const a = Math.floor(pos),
        b = Math.max(a + 1, Math.floor(pos + this.ratio));
      let s = 0;
      for (let i = a; i < b; i++) s += buf[i];
      out.push(s / (b - a));
      pos += this.ratio;
    }
    const keep = Math.floor(pos);
    this.carry = buf.slice(keep);
    this.pos = pos - keep;
    if (!out.length) return;

    const pcm = new Int16Array(out.length);
    let sumSq = 0;
    for (let i = 0; i < out.length; i++) {
      const v = Math.max(-1, Math.min(1, out[i]));
      pcm[i] = v < 0 ? v * 32768 : v * 32767;
      sumSq += v * v;
      // 20 ms frames for silence detection
      this.frameAcc[this.frameN++] = v;
      if (this.frameN === FRAME) {
        let e = 0;
        for (let j = 0; j < FRAME; j++) e += this.frameAcc[j] * this.frameAcc[j];
        const rms = Math.sqrt(e / FRAME);
        this.noiseFloor = rms < this.noiseFloor ? rms * 0.3 + this.noiseFloor * 0.7 : this.noiseFloor * 0.999 + rms * 0.001;
        const threshold = Math.max(0.008, this.noiseFloor * 2.5);
        this.silenceRun = rms < threshold ? this.silenceRun + FRAME : 0;
        this.frameN = 0;
      }
    }
    this.snap.level = Math.min(1, Math.sqrt(sumSq / out.length) * 6);
    this.parts.push(pcm);
    this.pieceLen += pcm.length;
    for (const p of peaksOf(pcm)) this.peakBuf.push(p);

    if ((this.pieceLen >= MIN_PIECE && this.silenceRun >= SILENCE_CUT) || this.pieceLen >= MAX_PIECE) {
      void this.commitPiece();
    }
  }

  private takePiece() {
    const data = new Int16Array(this.pieceLen);
    let o = 0;
    for (const p of this.parts) {
      data.set(p, o);
      o += p.length;
    }
    this.parts = [];
    this.pieceLen = 0;
    return data;
  }

  private async commitPiece(force = false) {
    const id = this.snap.meetingId;
    if (!id || (!force && this.pieceLen < RATE * 0.5)) return;
    const data = this.takePiece();
    if (data.length < RATE * 0.5) return;
    const piece: Piece = {
      meetingId: id,
      index: this.pieceIndex++,
      start: this.committed / RATE,
      duration: data.length / RATE,
      state: "pending",
      attempts: 0,
    };
    this.committed += data.length;
    await db.savePiece(piece, data);
    await db.setKv("partial:" + id, null);
    store.update(id, { duration: this.committed / RATE });
    transcriber.kick();
  }

  private onTick() {
    const id = this.snap.meetingId;
    if (!id) return;
    const elapsed = (this.committed + this.pieceLen) / RATE;
    this.set({ elapsed, level: this.snap.state === "recording" ? this.snap.level : 0 });
    const now = Date.now();
    if (now - this.lastPeaksPush > 2000 && this.peakBuf.length) {
      const fresh = this.peakBuf;
      this.peakBuf = [];
      store.update(id, (m) => ({ peaks: [...m.peaks, ...fresh], duration: elapsed }), { debounce: true });
      this.lastPeaksPush = now;
    }
    if (now - this.lastCheckpoint > 5000 && this.pieceLen > RATE) {
      this.lastCheckpoint = now;
      void this.checkpoint();
    }
  }

  /** Saves the piece in progress so a crash loses at most ~5 seconds. */
  private async checkpoint() {
    const id = this.snap.meetingId;
    if (!id) return;
    const data = new Int16Array(this.pieceLen);
    let o = 0;
    for (const p of this.parts) {
      data.set(p, o);
      o += p.length;
    }
    await db.setKv("partial:" + id, { index: this.pieceIndex, start: this.committed / RATE, data: data.buffer });
  }

  pause() {
    if (this.snap.state !== "recording") return;
    this.mr?.state === "recording" && this.mr.pause();
    this.set({ state: "paused", level: 0 });
    void this.checkpoint();
  }
  resume() {
    if (this.snap.state !== "paused") return;
    this.mr?.state === "paused" && this.mr.resume();
    this.set({ state: "recording" });
  }

  /** Called after the mic was taken away (phone call, Siri, app switch). */
  async reconnect() {
    const id = this.snap.meetingId;
    if (!id || this.snap.state !== "interrupted") return;
    try {
      this.disconnectInput();
      await this.openInput(id);
      this.set({ state: "recording", error: "" });
    } catch (e) {
      this.set({ error: friendlyMicError(e) });
    }
  }

  async stop() {
    const id = this.snap.meetingId;
    if (!id || this.snap.state === "stopping") return;
    this.set({ state: "stopping" });
    await this.commitPiece(true);
    if (this.peakBuf.length) {
      const fresh = this.peakBuf;
      this.peakBuf = [];
      store.update(id, (m) => ({ peaks: [...m.peaks, ...fresh] }));
    }
    await new Promise<void>((resolve) => {
      if (!this.mr || this.mr.state === "inactive") return resolve();
      const mr = this.mr;
      mr.addEventListener("stop", () => setTimeout(resolve, 300), { once: true });
      try {
        mr.stop();
      } catch {
        resolve();
      }
      setTimeout(resolve, 2500);
    });
    this.teardown();
    await db.setKv("partial:" + id, null);
    const duration = this.committed / RATE;
    store.update(id, { status: duration > 0.5 ? "processing" : "ready", duration });
    if (duration <= 0.5) store.update(id, { notesError: "The recording was too short." });
    this.set({ state: "idle", meetingId: null, elapsed: 0, level: 0 });
    transcriber.kick();
    void transcriber.finishIfDone(id);
    return id;
  }

  private disconnectInput() {
    try {
      this.mr?.state !== "inactive" && this.mr?.stop();
    } catch {}
    this.mr = null;
    this.stream?.getTracks().forEach((t) => {
      t.removeEventListener("ended", this.onTrackEnded);
      t.stop();
    });
    this.stream = null;
    try {
      this.source?.disconnect();
      this.node?.disconnect();
    } catch {}
    this.source = null;
    this.node = null;
  }

  private teardown() {
    window.clearInterval(this.tick);
    document.removeEventListener("visibilitychange", this.onVisibility);
    window.removeEventListener("pagehide", this.onPageHide);
    this.disconnectInput();
    void this.ctx?.close().catch(() => {});
    this.ctx = null;
    try {
      this.wakeLock?.release();
    } catch {}
    this.wakeLock = null;
  }

  private onTrackEnded = () => {
    if (this.snap.state === "recording" || this.snap.state === "paused") {
      void this.checkpoint();
      this.set({ state: "interrupted", level: 0 });
    }
  };

  private onVisibility = async () => {
    if (document.visibilityState === "hidden") {
      void this.checkpoint();
      return;
    }
    if (!this.active) return;
    void this.lockScreen();
    if (this.ctx && this.ctx.state !== "running") {
      try {
        await this.ctx.resume();
      } catch {}
    }
    const live = this.stream?.getAudioTracks()[0]?.readyState === "live";
    if (!live && this.snap.state === "recording") this.set({ state: "interrupted" });
  };

  private onPageHide = () => void this.checkpoint();

  private async lockScreen() {
    try {
      if ("wakeLock" in navigator && !this.wakeLock) {
        this.wakeLock = await (navigator as any).wakeLock.request("screen");
        this.wakeLock.addEventListener?.("release", () => (this.wakeLock = null));
      }
    } catch {
      /* not supported or not allowed */
    }
  }
}

function friendlyMicError(e: any) {
  const name = e?.name || "";
  if (name === "NotAllowedError" || name === "SecurityError")
    return "Microphone access is blocked. Allow the microphone for this site in your browser settings, then try again.";
  if (name === "NotFoundError") return "No microphone was found on this device.";
  if (name === "NotReadableError") return "Another app is using the microphone. Close it and try again.";
  return e?.message || "The microphone could not be started.";
}

export const recorder = new Recorder();

/**
 * After a crash or the app being closed mid-recording: turn the last
 * checkpoint into a piece and finish processing what was captured.
 */
export async function recoverInterruptedRecordings() {
  for (const m of store.all().filter((x) => x.status === "recording")) {
    if (recorder.snap.meetingId === m.id) continue;
    const partial = await db.kv<{ index: number; start: number; data: ArrayBuffer } | null>("partial:" + m.id);
    if (partial?.data?.byteLength) {
      const data = new Int16Array(partial.data);
      const existing = await db.pieces(m.id);
      const index = Math.max(partial.index, ...existing.map((p) => p.index + 1), 0);
      const start = existing.reduce((end, p) => Math.max(end, p.start + p.duration), partial.start);
      await db.savePiece({ meetingId: m.id, index, start, duration: data.length / RATE, state: "pending", attempts: 0 }, data);
      await db.setKv("partial:" + m.id, null);
    }
    const pieces = await db.pieces(m.id);
    const duration = pieces.reduce((end, p) => Math.max(end, p.start + p.duration), 0);
    store.update(m.id, {
      status: pieces.length ? "processing" : "ready",
      duration,
      ...(pieces.length ? {} : { notesError: "This recording was interrupted before any audio was saved." }),
    });
    void transcriber.finishIfDone(m.id);
  }
  transcriber.kick();
}
