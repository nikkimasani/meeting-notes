import { db } from "./db";
import { newMeeting, store, uid } from "./store";
import { generateNotes } from "./ai";
import { decodeToPcm, peaksOf } from "./audio";
import { processStoredAudio } from "./importer";
import type { BotInfo, Meeting, Segment } from "./types";

// On-demand notetaker. Nothing here runs unless you tap "Send notetaker".

export function platformOf(url: string) {
  try {
    const h = new URL(url).hostname;
    if (/teams\.(microsoft|live)\.com$/.test(h)) return "Teams";
    if (/zoom\.us$/.test(h)) return "Zoom";
    if (h === "meet.google.com") return "Google Meet";
    if (/webex\.com$/.test(h)) return "Webex";
  } catch {}
  return "";
}

export async function botConfigured(): Promise<boolean> {
  try {
    const r = await fetch("/api/bot?check=1");
    return !!(await r.json()).configured;
  } catch {
    return false;
  }
}

export async function sendBot(opts: { url: string; title?: string; joinAt?: string | null }) {
  const res = await fetch("/api/bot", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "create", meetingUrl: opts.url.trim(), joinAt: opts.joinAt || null }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Could not send the notetaker (${res.status}).`);
  const platform = platformOf(opts.url);
  const when = opts.joinAt ? new Date(opts.joinAt) : new Date();
  const m = newMeeting({
    title: opts.title?.trim() || `${platform || "Online"} call · ${when.toLocaleDateString(undefined, { month: "short", day: "numeric" })}, ${when.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`,
    titleIsAuto: !opts.title?.trim(),
    createdAt: when.toISOString(),
    status: "bot",
    source: "bot",
    hasPcm: false,
    bot: {
      id: data.id,
      url: opts.url.trim(),
      platform,
      joinAt: data.scheduled ? data.joinAt || opts.joinAt || null : null,
      code: data.scheduled ? "scheduled" : "ready",
      sentAt: new Date().toISOString(),
    },
  });
  await store.add(m);
  botWatcher.kick();
  return m.id;
}

async function botAction(m: Meeting, action: "leave" | "cancel") {
  if (!m.bot) return;
  const res = await fetch("/api/bot", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action, id: m.bot.id }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "The notetaker didn't respond.");
  return data;
}
export async function makeBotLeave(m: Meeting) {
  await botAction(m, "leave");
  store.update(m.id, (x) => ({ bot: x.bot && { ...x.bot, code: "leaving" } }));
  botWatcher.kick();
}
export async function cancelBot(m: Meeting) {
  const r = await botAction(m, "cancel");
  if (r?.cancelled || !m.bot || ["scheduled", "ready", "joining_call", "in_waiting_room"].includes(m.bot.code)) {
    const hasAudio = m.audioFiles.length > 0;
    if (!hasAudio && !m.segments.length) await store.remove(m.id);
    else store.update(m.id, { status: "ready", bot: { ...m.bot!, code: "cancelled" } });
  } else botWatcher.kick();
}

const SUB_CODES: Record<string, string> = {
  bot_kicked_from_waiting_room: "Someone removed the notetaker from the lobby.",
  bot_kicked_from_call: "The notetaker was removed from the call.",
  timeout_exceeded_waiting_room: "Nobody admitted the notetaker from the lobby in time.",
  call_ended_by_platform_waiting_room_timeout: "Nobody admitted the notetaker from the lobby in time.",
  meeting_not_found: "That meeting link didn't work.",
  meeting_link_invalid: "That meeting link didn't work.",
  meeting_requires_sign_in: "This meeting only allows signed-in users, so the notetaker couldn't join.",
  recording_permission_denied: "The host didn't allow recording.",
  timeout_exceeded_noone_joined: "Nobody else joined, so the notetaker left.",
  timeout_exceeded_everyone_left: "Everyone left, so the notetaker left too.",
};
export function botLabel(b: BotInfo): { text: string; tone: "busy" | "warn" | "wait"; canLeave: boolean; canCancel: boolean } {
  const who = b.platform || "the call";
  switch (b.code) {
    case "scheduled":
      return { text: `Scheduled to join ${who} at ${b.joinAt ? new Date(b.joinAt).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" }) : "the start time"}`, tone: "wait", canLeave: false, canCancel: true };
    case "ready":
    case "joining_call":
      return { text: `Joining ${who}…`, tone: "busy", canLeave: false, canCancel: true };
    case "in_waiting_room":
      return { text: `Waiting in the lobby — admit “Recapp Notetaker” in ${who}`, tone: "warn", canLeave: false, canCancel: true };
    case "in_call_not_recording":
    case "recording_permission_allowed":
      return { text: `In the call, starting to record…`, tone: "busy", canLeave: true, canCancel: false };
    case "recording_permission_denied":
      return { text: `The host didn't allow recording`, tone: "warn", canLeave: true, canCancel: false };
    case "in_call_recording":
      return { text: `Recording ${who}`, tone: "busy", canLeave: true, canCancel: false };
    case "leaving":
      return { text: `Leaving the call…`, tone: "busy", canLeave: false, canCancel: false };
    case "call_ended":
    case "recording_done":
    case "done":
      return { text: `Call ended — preparing transcript (can take a few minutes)`, tone: "busy", canLeave: false, canCancel: false };
    default:
      return { text: b.message || `Notetaker status: ${b.code}`, tone: "busy", canLeave: false, canCancel: true };
  }
}

// ---------- Watcher: polls only meetings that have an active bot ----------
let timer: number | undefined;
let running = false;
const finishing = new Set<string>();

export const botWatcher = {
  kick() {
    window.clearTimeout(timer);
    void tick();
  },
};

async function tick() {
  if (running) return;
  running = true;
  try {
    const active = store.all().filter((m) => m.status === "bot" && m.bot);
    for (const m of active) await check(m);
  } finally {
    running = false;
    const stillActive = store.all().some((m) => m.status === "bot");
    if (stillActive) timer = window.setTimeout(() => void tick(), document.visibilityState === "visible" ? 10_000 : 30_000);
  }
}

async function check(m: Meeting) {
  if (!m.bot || finishing.has(m.id)) return;
  if (m.bot.code === "scheduled" && m.bot.joinAt && +new Date(m.bot.joinAt) - Date.now() > 3 * 60_000) return;
  let data: any;
  try {
    const res = await fetch(`/api/bot?id=${encodeURIComponent(m.bot.id)}`);
    data = await res.json().catch(() => ({}));
    if (!res.ok) {
      if (res.status === 404) store.update(m.id, { status: "error", error: "The notetaker for this meeting no longer exists." });
      return;
    }
  } catch {
    return; // offline; try later
  }
  const code = data.state?.code || m.bot.code;
  const changed = code !== m.bot.code || data.state?.subCode !== m.bot.subCode;
  if (changed)
    store.update(m.id, (x) => ({ bot: x.bot && { ...x.bot, code: m.bot!.code === "leaving" && !["call_ended", "done", "fatal"].includes(code) ? "leaving" : code, subCode: data.state?.subCode, message: data.state?.message } }));

  if (code === "fatal" && !data.recorded) {
    store.update(m.id, { status: "error", error: SUB_CODES[data.state?.subCode] || data.state?.message || "The notetaker couldn't join this call." });
    return;
  }
  if (code === "done" || (code === "fatal" && data.recorded)) {
    const transcriptPending = data.transcriptState && !["done", "failed", "missing", "unknown"].includes(data.transcriptState);
    const waitedMin = (Date.now() - +new Date(data.state?.at || Date.now())) / 60_000;
    if (!data.transcript && transcriptPending && waitedMin < 20) return; // still processing on Recall's side
    await finish(m, data);
  } else if (code === "call_ended" && !data.recorded) {
    store.update(m.id, { status: "error", error: SUB_CODES[data.state?.subCode] || "The call ended before anything was recorded." });
  }
}

async function finish(m: Meeting, data: any) {
  finishing.add(m.id);
  try {
    // 1. Audio (for playback + export)
    if (data.audioUrl && !m.audioFiles.length) {
      try {
        const res = await fetch(String(data.audioUrl).startsWith("/api/") ? data.audioUrl : `/api/recall-audio?u=${encodeURIComponent(data.audioUrl)}`);
        if (res.ok) {
          const buf = await res.arrayBuffer();
          const type = (res.headers.get("content-type") || "audio/mpeg").split(";")[0];
          const key = `${m.id}:original`;
          await db.saveAudio(key, buf, type);
          const ext = type.includes("mp4") ? "m4a" : type.includes("webm") ? "webm" : type.includes("wav") ? "wav" : type.includes("ogg") ? "ogg" : "mp3";
          store.update(m.id, { audioFiles: [{ name: `call.${ext}`, type, key }] });
          const peaks: number[] = [];
          let seconds = 0;
          await decodeToPcm(new Blob([buf], { type }), (pcm) => {
            peaks.push(...peaksOf(pcm));
            seconds += pcm.length / 16000;
          }).catch(() => {});
          if (peaks.length) store.update(m.id, { peaks, duration: Math.round(seconds) });
        }
      } catch {
        /* audio is optional */
      }
    }
    // 2. Transcript — Recall knows each participant's real name.
    const raw: { speaker: string; text: string; start: number; end: number }[] = Array.isArray(data.transcript) ? data.transcript : [];
    if (raw.length) {
      const ids = new Map<string, string>();
      const speakers: Record<string, string> = {};
      const segments: Segment[] = raw.map((s) => {
        if (!ids.has(s.speaker)) {
          const id = `S${ids.size + 1}`;
          ids.set(s.speaker, id);
          speakers[id] = s.speaker;
        }
        return { id: uid(), speaker: ids.get(s.speaker)!, text: s.text, start: s.start, end: s.end };
      });
      const duration = Math.max(store.get(m.id)?.duration || 0, Math.round(raw[raw.length - 1].end));
      store.update(m.id, { segments, speakers, status: "ready", duration, error: undefined });
      void generateNotes(m.id);
    } else if (store.get(m.id)?.audioFiles.length) {
      // No transcript from the bot: run the audio through our own transcription.
      store.update(m.id, { status: "needs_audio_processing" });
      await processStoredAudio(m.id);
    } else {
      store.update(m.id, { status: "error", error: "The call ended, but no transcript or audio came back from the notetaker." });
    }
  } finally {
    finishing.delete(m.id);
  }
}
