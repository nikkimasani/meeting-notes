import React, { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { Meeting } from "../lib/types";
import { transcriber, pieceStats } from "../lib/transcriber";
import { importProgress } from "../lib/importer";
import { isGeneratingNotes } from "../lib/ai";
import { botLabel } from "../lib/bot";

// ---------- Routing (hash based so the phone's back gesture works) ----------
export type Route =
  | { name: "home" }
  | { name: "meeting"; id: string; tab: Tab }
  | { name: "record" }
  | { name: "ask" }
  | { name: "tasks" }
  | { name: "settings" };
export type Tab = "summary" | "transcript" | "insights" | "highlights" | "chat" | "notes";

function parse(): Route {
  const h = location.hash.replace(/^#\/?/, "");
  const [path, query] = h.split("?");
  const parts = path.split("/");
  if (parts[0] === "m" && parts[1]) {
    const tab = new URLSearchParams(query).get("tab") as Tab | null;
    return { name: "meeting", id: parts[1], tab: tab || "summary" };
  }
  if (parts[0] === "record") return { name: "record" };
  if (parts[0] === "ask") return { name: "ask" };
  if (parts[0] === "tasks") return { name: "tasks" };
  if (parts[0] === "settings") return { name: "settings" };
  return { name: "home" };
}
let route = parse();
const routeListeners = new Set<() => void>();
let depth = 0;
window.addEventListener("popstate", () => (depth = Math.max(0, depth - 1)));
window.addEventListener("hashchange", () => {
  route = parse();
  routeListeners.forEach((l) => l());
  window.scrollTo(0, 0);
});
export const useRoute = () =>
  useSyncExternalStore(
    (l) => {
      routeListeners.add(l);
      return () => routeListeners.delete(l);
    },
    () => route,
  );
export function go(path: string, replace = false) {
  const hash = "#/" + path.replace(/^\//, "");
  if (replace) history.replaceState(null, "", hash);
  else {
    history.pushState(null, "", hash);
    depth++;
  }
  route = parse();
  routeListeners.forEach((l) => l());
  if (!replace) window.scrollTo(0, 0);
}
/** Goes back within the app, or to a fallback screen if the app was opened here. */
export function back(fallback = "") {
  if (depth > 0) history.back();
  else go(fallback, true);
}

// ---------- Toasts ----------
type Toast = { id: number; text: string; tone: "ok" | "error" };
let toasts: Toast[] = [];
const toastListeners = new Set<() => void>();
export function toast(text: string, tone: Toast["tone"] = "ok") {
  const t = { id: Date.now() + Math.random(), text, tone };
  toasts = [...toasts, t];
  toastListeners.forEach((l) => l());
  setTimeout(() => {
    toasts = toasts.filter((x) => x.id !== t.id);
    toastListeners.forEach((l) => l());
  }, tone === "error" ? 6000 : 2600);
}
export function Toasts() {
  const list = useSyncExternalStore(
    (l) => {
      toastListeners.add(l);
      return () => toastListeners.delete(l);
    },
    () => toasts,
  );
  return (
    <div className="toasts" aria-live="polite">
      {list.map((t) => (
        <div key={t.id} className={`toast toast-${t.tone}`}>
          {t.text}
        </div>
      ))}
    </div>
  );
}

// ---------- Formatting ----------
export const clock = (sec: number) => {
  const s = Math.max(0, Math.floor(sec || 0)),
    h = Math.floor(s / 3600),
    m = Math.floor((s % 3600) / 60),
    r = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${r}` : `${m}:${r}`;
};
export const minutes = (sec: number) => {
  if (!sec) return "";
  const m = Math.round(sec / 60);
  if (m < 1) return "<1 min";
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)}h ${m % 60 ? `${m % 60}m` : ""}`.trim();
};
export const timeOf = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
export function dayLabel(iso: string) {
  const d = new Date(iso),
    t = new Date(),
    y = new Date();
  y.setDate(t.getDate() - 1);
  if (d.toDateString() === t.toDateString()) return "Today";
  if (d.toDateString() === y.toDateString()) return "Yesterday";
  const diff = (+t - +d) / 864e5;
  if (diff < 6) return d.toLocaleDateString(undefined, { weekday: "long" });
  return d.toLocaleDateString(undefined, {
    month: "long",
    day: "numeric",
    ...(d.getFullYear() !== t.getFullYear() ? { year: "numeric" } : {}),
  });
}

// ---------- Speakers ----------
const SPEAKER_COLORS = ["#ff7a45", "#2bb3a3", "#8c6cf2", "#e8558f", "#3d8bfd", "#c9a227", "#5aa65a", "#d4683e"];
export const speakerColor = (id: string) => {
  const n = parseInt(id.replace(/\D/g, ""), 10);
  return SPEAKER_COLORS[(Number.isFinite(n) ? n - 1 : 0) % SPEAKER_COLORS.length];
};
export function Avatar({ name, id, size = 32 }: { name: string; id: string; size?: number }) {
  const numbered = name.match(/^Speaker\s+(\d+)$/i);
  const initials = numbered
    ? numbered[1]
    : name
        .split(/\s+/)
        .map((w) => w[0])
        .join("")
        .slice(0, 2)
        .toUpperCase();
  return (
    <span className="avatar" style={{ width: size, height: size, background: speakerColor(id), fontSize: size * 0.38 }}>
      {initials}
    </span>
  );
}

export function AvatarStack({ m, max = 4, size = 26 }: { m: Meeting; max?: number; size?: number }) {
  const ids = [...new Set(m.segments.map((s) => s.speaker))];
  if (!ids.length) return null;
  const name = (id: string) => m.speakers[id] || (id.startsWith("S") ? `Speaker ${id.slice(1)}` : id);
  return (
    <span className="stack" aria-label={`${ids.length} speaker${ids.length === 1 ? "" : "s"}`}>
      {ids.slice(0, max).map((id) => (
        <Avatar key={id} id={id} name={name(id)} size={size} />
      ))}
      {ids.length > max && (
        <span className="avatar more" style={{ width: size, height: size, fontSize: size * 0.36 }}>
          +{ids.length - max}
        </span>
      )}
    </span>
  );
}

/** Where a meeting came from: phone recording, a notetaker in a call, or an imported file. */
export function SourceBadge({ m }: { m: Meeting }) {
  const p = m.bot?.platform || "";
  const kind = m.source === "bot" ? (p === "Google Meet" ? "meet" : p.toLowerCase() || "call") : m.source === "import" ? "import" : "mic";
  const label = m.source === "bot" ? p || "Call" : m.source === "import" ? "Imported" : "In person";
  return (
    <span className={`src src-${kind}`}>
      <i />
      {label}
    </span>
  );
}

// ---------- Waveform ----------
export function Waveform({
  peaks,
  bars = 64,
  progress = -1,
  onSeek,
  className = "",
  height = 32,
}: {
  peaks: number[];
  bars?: number;
  progress?: number;
  onSeek?: (fraction: number) => void;
  className?: string;
  height?: number;
}) {
  const ref = useRef<SVGSVGElement | null>(null);
  const values = React.useMemo(() => {
    if (!peaks.length) return Array.from({ length: bars }, (_, i) => 0.08 + 0.04 * Math.sin(i));
    const out: number[] = [];
    const step = peaks.length / bars;
    for (let i = 0; i < bars; i++) {
      const a = Math.floor(i * step),
        b = Math.max(a + 1, Math.floor((i + 1) * step));
      let max = 0;
      for (let j = a; j < b && j < peaks.length; j++) max = Math.max(max, peaks[j]);
      out.push(Math.max(0.06, max));
    }
    return out;
  }, [peaks, bars]);
  const seek = (e: React.PointerEvent) => {
    if (!onSeek || !ref.current) return;
    const r = ref.current.getBoundingClientRect();
    onSeek(Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)));
  };
  const gap = 0.35;
  return (
    <svg
      ref={ref}
      className={`waveform ${onSeek ? "seekable" : ""} ${className}`}
      viewBox={`0 0 ${bars} ${height}`}
      preserveAspectRatio="none"
      height={height}
      onPointerDown={(e) => {
        if (!onSeek) return;
        (e.target as Element).setPointerCapture?.(e.pointerId);
        seek(e);
      }}
      onPointerMove={(e) => e.buttons && seek(e)}
      aria-hidden={!onSeek}
      role={onSeek ? "slider" : undefined}
      aria-label={onSeek ? "Seek" : undefined}
      aria-valuenow={onSeek ? Math.round(progress * 100) : undefined}
    >
      {values.map((v, i) => {
        const h = Math.max(1.5, v * height);
        return (
          <rect
            key={i}
            x={i + gap / 2}
            y={(height - h) / 2}
            width={1 - gap}
            height={h}
            rx={0.3}
            className={progress >= 0 && i / bars < progress ? "played" : ""}
          />
        );
      })}
    </svg>
  );
}

// ---------- Sheet (bottom sheet on phone, dialog on desktop) ----------
export function Sheet({
  open,
  onClose,
  title,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    document.body.classList.add("no-scroll");
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.classList.remove("no-scroll");
    };
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="sheet-layer" role="dialog" aria-modal="true" aria-label={title}>
      <button className="sheet-scrim" aria-label="Close" onClick={onClose} />
      <div className="sheet">
        <div className="sheet-grab" />
        <h2 className="sheet-title">{title}</h2>
        {children}
      </div>
    </div>
  );
}

// ---------- Processing status for a meeting ----------
export function useTick(ms: number, on = true) {
  const [, set] = useState(0);
  useEffect(() => {
    if (!on) return;
    const id = setInterval(() => set((n) => n + 1), ms);
    return () => clearInterval(id);
  }, [ms, on]);
}
export function usePieceStats(m: Meeting | undefined) {
  const [stats, setStats] = useState<{ total: number; done: number; failed: number; pending: number } | null>(null);
  const active = !!m && (m.status === "processing" || m.status === "recording" || m.status === "error");
  useEffect(() => {
    if (!m || !active) return setStats(null);
    let alive = true;
    const load = () => void pieceStats(m.id).then((s) => alive && setStats(s));
    load();
    const off = transcriber.onChange(load);
    const id = setInterval(load, 3000);
    return () => {
      alive = false;
      off();
      clearInterval(id);
    };
  }, [m?.id, active, m?.segments.length]);
  return stats;
}
export function useImportProgress(id: string | undefined) {
  return useSyncExternalStore(importProgress.subscribe, () => (id ? importProgress.get(id) : undefined));
}

export function statusText(m: Meeting, stats: ReturnType<typeof usePieceStats>, importing?: number) {
  if (m.status === "recording") return "Recording";
  if (m.status === "bot" && m.bot) return botLabel(m.bot).text;
  if (importing !== undefined) return `Reading audio… ${Math.round(importing * 100)}%`;
  if (m.status === "processing")
    return stats && stats.total
      ? `Transcribing · ${stats.done} of ${stats.total} parts${navigator.onLine ? "" : " · waiting for connection"}`
      : "Transcribing…";
  if (m.status === "needs_audio_processing") return "Ready to transcribe";
  if (m.status === "error") return "Needs attention";
  if (isGeneratingNotes(m.id)) return "Writing notes…";
  return "";
}

export function Empty({ icon, title, body, action }: { icon: React.ReactNode; title: string; body: string; action?: React.ReactNode }) {
  return (
    <div className="empty">
      <div className="empty-mark">{icon}</div>
      <h3>{title}</h3>
      <p>{body}</p>
      {action}
    </div>
  );
}

export function useOnline() {
  return useSyncExternalStore(
    (l) => {
      window.addEventListener("online", l);
      window.addEventListener("offline", l);
      return () => {
        window.removeEventListener("online", l);
        window.removeEventListener("offline", l);
      };
    },
    () => navigator.onLine,
  );
}
