import { useSyncExternalStore } from "react";
import { db } from "./db";
import type { Meeting } from "./types";

type State = { meetings: Map<string, Meeting>; loaded: boolean };
let state: State = { meetings: new Map(), loaded: false };
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

const saveTimers = new Map<string, number>();
const pendingSaves = new Set<string>();

function persist(id: string, immediate: boolean) {
  window.clearTimeout(saveTimers.get(id));
  const write = () => {
    saveTimers.delete(id);
    pendingSaves.delete(id);
    const m = state.meetings.get(id);
    if (m) void db.saveMeeting(m).catch((e) => console.error("save failed", e));
  };
  pendingSaves.add(id);
  if (immediate) write();
  else saveTimers.set(id, window.setTimeout(write, 400));
}

/** Writes any edits still waiting on the debounce (called when the page hides). */
export function flushSaves() {
  [...pendingSaves].forEach((id) => persist(id, true));
}

export const store = {
  get: (id: string) => state.meetings.get(id),
  all: () => [...state.meetings.values()],
  async load() {
    const list = await db.meetings();
    state = { meetings: new Map(list.map((m) => [m.id, m])), loaded: true };
    emit();
  },
  /** Applies a change. Text edits debounce; structural changes write at once. */
  update(id: string, patch: Partial<Meeting> | ((m: Meeting) => Partial<Meeting>), opts: { debounce?: boolean } = {}) {
    const current = state.meetings.get(id);
    if (!current) return;
    const change = typeof patch === "function" ? patch(current) : patch;
    const next = { ...current, ...change, updatedAt: new Date().toISOString() };
    const meetings = new Map(state.meetings);
    meetings.set(id, next);
    state = { ...state, meetings };
    emit();
    persist(id, !opts.debounce);
  },
  async add(m: Meeting) {
    const meetings = new Map(state.meetings);
    meetings.set(m.id, m);
    state = { ...state, meetings };
    emit();
    await db.saveMeeting(m);
  },
  async remove(id: string) {
    const meetings = new Map(state.meetings);
    meetings.delete(id);
    state = { ...state, meetings };
    emit();
    await db.deleteMeeting(id);
  },
};

let snapshotRef = state;
let listSnapshot: Meeting[] = [];
function getList() {
  if (snapshotRef !== state || (!listSnapshot.length && state.meetings.size)) {
    snapshotRef = state;
    listSnapshot = [...state.meetings.values()].sort(
      (a, b) => +new Date(b.createdAt) - +new Date(a.createdAt),
    );
  }
  return listSnapshot;
}

export function useMeetings() {
  return useSyncExternalStore(subscribe, getList);
}
export function useMeeting(id: string | undefined) {
  return useSyncExternalStore(subscribe, () => (id ? state.meetings.get(id) : undefined));
}
export function useLoaded() {
  return useSyncExternalStore(subscribe, () => state.loaded);
}

export const uid = () =>
  (crypto.randomUUID?.() || Math.random().toString(36).slice(2) + Date.now().toString(36)).replace(/-/g, "").slice(0, 16);

export function newMeeting(partial: Partial<Meeting> = {}): Meeting {
  const now = new Date();
  return {
    id: uid(),
    title: `Meeting ${now.toLocaleDateString(undefined, { month: "short", day: "numeric" })}, ${now.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`,
    titleIsAuto: true,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    duration: 0,
    status: "recording",
    segments: [],
    speakers: {},
    chat: [],
    userNotes: "",
    tags: [],
    starred: false,
    peaks: [],
    hasPcm: true,
    audioFiles: [],
    source: "recording",
    language: localStorage.getItem("sd-language") || "auto",
    ...partial,
  };
}
