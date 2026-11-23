import { useMemo, useState } from "react";
import {
  Search,
  Upload,
  Star,
  X,
  Sparkles,
  Mic,
  Bot,
  CalendarClock,
  ChevronRight,
  Download,
  Users,
  ListChecks,
  Highlighter,
  FileText,
  Languages,
  Plus,
} from "lucide-react";
import { BotSheet } from "./BotSheet";
import { ExportSheet } from "./ExportSheet";
import { store, useMeetings } from "../lib/store";
import { importFile } from "../lib/importer";
import { botLabel, cancelBot } from "../lib/bot";
import type { Meeting } from "../lib/types";
import {
  AvatarStack,
  SourceBadge,
  Waveform,
  clock,
  dayLabel,
  go,
  minutes,
  statusText,
  timeOf,
  toast,
  useImportProgress,
  usePieceStats,
  useTick,
} from "./kit";
import { useRecorder } from "./Rail";
import { TaskRow } from "./Tasks";

const ACCEPT = "audio/*,video/*,.m4a,.mp3,.wav,.mp4,.mov,.webm";

function greeting() {
  const h = new Date().getHours();
  return h < 5 ? "Working late" : h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening";
}

export function Home() {
  const meetings = useMeetings();
  const rec = useRecorder();
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [filter, setFilter] = useState<"all" | "starred" | "tasks" | "calls">("all");
  const [bot, setBot] = useState<null | "now" | "later">(null);
  const [exportOpen, setExportOpen] = useState(false);
  useTick(30_000);

  const past = useMemo(() => meetings.filter((m) => !(m.status === "bot" && m.bot?.code === "scheduled")), [meetings]);
  const scheduled = useMemo(
    () =>
      meetings
        .filter((m) => m.status === "bot" && m.bot?.code === "scheduled")
        .sort((a, b) => +new Date(a.bot?.joinAt || a.createdAt) - +new Date(b.bot?.joinAt || b.createdAt)),
    [meetings],
  );
  const liveBots = meetings.filter((m) => m.status === "bot" && m.bot && m.bot.code !== "scheduled");

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return past.filter((m) => {
      if (filter === "starred" && !m.starred) return false;
      if (filter === "tasks" && !m.notes?.actions.some((a) => !a.done)) return false;
      if (filter === "calls" && m.source !== "bot") return false;
      if (!q) return true;
      return (
        m.title.toLowerCase().includes(q) ||
        (m.notes?.summary || "").toLowerCase().includes(q) ||
        m.tags.some((t) => t.toLowerCase().includes(q)) ||
        m.segments.some((s) => s.text.toLowerCase().includes(q)) ||
        Object.values(m.speakers).some((n) => n.toLowerCase().includes(q)) ||
        m.userNotes.toLowerCase().includes(q)
      );
    });
  }, [past, query, filter]);

  const groups = useMemo(() => {
    const out: [string, Meeting[]][] = [];
    for (const m of visible) {
      const label = dayLabel(m.createdAt);
      const last = out[out.length - 1];
      if (last && last[0] === label) last[1].push(m);
      else out.push([label, [m]]);
    }
    return out;
  }, [visible]);

  const openTasks = useMemo(
    () =>
      past
        .flatMap((m) => (m.notes?.actions || []).filter((a) => !a.done && a.task.trim()).map((a) => ({ m, a })))
        .slice(0, 4),
    [past],
  );
  const openCount = past.reduce((n, m) => n + (m.notes?.actions.filter((a) => !a.done && a.task.trim()).length || 0), 0);
  const week = past.filter((m) => Date.now() - +new Date(m.createdAt) < 7 * 864e5);
  const weekSec = week.reduce((n, m) => n + m.duration, 0);
  const hlCount = past.reduce((n, m) => n + m.segments.filter((s) => s.highlight).length, 0);

  const onImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    if (file.size > 500 * 1024 * 1024) return toast("That file is over 500 MB. Trim it and try again.", "error");
    const id = await importFile(file);
    toast("Importing — transcription starts in a moment");
    go("m/" + id + "?tab=transcript");
  };

  const today = new Date().toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });

  return (
    <div className="home">
      <header className="home-head">
        <div className="home-brand">
          <img src="/recapp-mark.png" alt="" />
          <span>Recapp</span>
        </div>
        <div className="home-tools">
          <button className="icon-btn" aria-label="Search" onClick={() => setSearching((s) => !s)}>
            {searching ? <X /> : <Search />}
          </button>
          <button className="icon-btn" aria-label="Export everything" title="Export everything" onClick={() => setExportOpen(true)} disabled={!past.length}>
            <Download />
          </button>
        </div>
      </header>

      <div className="hero">
        <p className="kicker">{today}</p>
        <h1 className="page-title">
          <span className="hl">{greeting()}</span>
        </h1>
        <div className="hero-tools">
          <button className="icon-btn" aria-label="Search" onClick={() => setSearching((s) => !s)}>
            {searching ? <X /> : <Search />}
          </button>
          <button className="btn btn-quiet btn-sm" onClick={() => setExportOpen(true)} disabled={!past.length}>
            <Download /> Export all
          </button>
        </div>
      </div>

      {(searching || query) && (
        <div className="search">
          <Search />
          <input
            autoFocus
            type="search"
            placeholder="Search people, topics, transcripts, notes"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Search meetings"
          />
        </div>
      )}

      <div className="home-grid">
        <div className="home-main">
          {(rec.state !== "idle" || liveBots.length > 0) && (
            <section className="sec sec-live">
              <h2 className="sec-title">Happening now</h2>
              {rec.state !== "idle" && <LiveRecordingCard />}
              {liveBots.map((m) => (
                <LiveBotCard key={m.id} m={m} />
              ))}
            </section>
          )}

          <section className="sec sec-actions" aria-label="Start">
            <div className="quick">
              <button className="qa qa-rec" onClick={() => go("record")}>
                <span className="qa-icon">
                  <Mic />
                </span>
                <b>Record</b>
                <small>In the room</small>
              </button>
              <button className="qa" onClick={() => setBot("now")}>
                <span className="qa-icon qa-ink">
                  <Bot />
                </span>
                <b>Notetaker</b>
                <small>Zoom · Meet · Teams</small>
              </button>
              <label className="qa">
                <span className="qa-icon">
                  <Upload />
                </span>
                <b>Import</b>
                <small>Audio or video</small>
                <input type="file" accept={ACCEPT} onChange={onImport} />
              </label>
              <button className="qa" onClick={() => go("ask")}>
                <span className="qa-icon qa-hl">
                  <Sparkles />
                </span>
                <b>Ask AI</b>
                <small>All meetings</small>
              </button>
            </div>
          </section>

          <section className="sec sec-stats" aria-label="This week">
            <div className="stats">
              <div>
                <b>{week.length}</b>
                <span>meetings this week</span>
              </div>
              <div>
                <b>{weekSec ? minutes(weekSec) : "0 min"}</b>
                <span>captured</span>
              </div>
              <button onClick={() => go("tasks")}>
                <b>{openCount}</b>
                <span>open tasks</span>
              </button>
              <div className="stat-hide-sm">
                <b>{hlCount}</b>
                <span>highlights</span>
              </div>
            </div>
          </section>

          <section className="sec sec-meetings">
            <div className="sec-head">
              <h2 className="sec-title">Meetings</h2>
              {past.length > 0 && <span className="sec-count mono">{past.length}</span>}
            </div>
            {past.length > 0 && (
              <div className="filters" role="group" aria-label="Filter">
                {(
                  [
                    ["all", "All"],
                    ["starred", "Starred"],
                    ["tasks", "Has open tasks"],
                    ["calls", "From calls"],
                  ] as const
                ).map(([k, label]) => (
                  <button key={k} className={filter === k ? "on" : ""} onClick={() => setFilter(k)}>
                    {label}
                  </button>
                ))}
              </div>
            )}
            {groups.length ? (
              groups.map(([label, list]) => (
                <div key={label} className="day">
                  <h3 className="day-label">{label}</h3>
                  <div className="rows">
                    {list.map((m) => (
                      <MeetingRow key={m.id} m={m} query={query} />
                    ))}
                  </div>
                </div>
              ))
            ) : past.length ? (
              <p className="quiet-note">Nothing matches.</p>
            ) : (
              <Features />
            )}
          </section>
        </div>

        <aside className="home-side">
          <section className="sec sec-upcoming card">
            <div className="sec-head">
              <h2 className="sec-title">Upcoming calls</h2>
              <button className="link-btn" onClick={() => setBot("later")}>
                <Plus /> Schedule
              </button>
            </div>
            {scheduled.length ? (
              <ul className="upcoming">
                {scheduled.map((m) => (
                  <UpcomingRow key={m.id} m={m} />
                ))}
              </ul>
            ) : (
              <button className="up-empty" onClick={() => setBot("later")}>
                <CalendarClock />
                <span>
                  <b>Nothing scheduled</b>
                  <small>Paste a Zoom, Meet or Teams link and the notetaker joins at the start time. It only goes where you send it.</small>
                </span>
              </button>
            )}
          </section>

          <section className="sec sec-tasks card">
            <div className="sec-head">
              <h2 className="sec-title">Action items</h2>
              <button className="link-btn" onClick={() => go("tasks")}>
                See all <ChevronRight />
              </button>
            </div>
            {openTasks.length ? (
              <ul className="task-list">
                {openTasks.map(({ m, a }) => (
                  <TaskRow key={a.id} m={m} a={a} />
                ))}
              </ul>
            ) : (
              <p className="quiet-note">{past.some((m) => m.notes?.actions.length) ? "All caught up — nothing open." : "Tasks people commit to in meetings show up here, with owners and due dates."}</p>
            )}
          </section>
        </aside>
      </div>

      <BotSheet open={bot !== null} mode={bot || "now"} onClose={() => setBot(null)} />
      <ExportSheet open={exportOpen} onClose={() => setExportOpen(false)} meetings={past} />
    </div>
  );
}

function LiveRecordingCard() {
  const rec = useRecorder();
  const m = rec.meetingId ? store.get(rec.meetingId) : undefined;
  return (
    <button className="live-card" onClick={() => go("record")}>
      <div className="lc-top">
        <span className="src src-mic">
          <i />
          In person
        </span>
        <span className={`live-pill ${rec.state === "paused" ? "paused" : ""}`}>
          <i />
          {rec.state === "paused" ? "PAUSED" : "LIVE"}
        </span>
      </div>
      <b className="lc-title">{m?.title || "New recording"}</b>
      <div className="lc-bottom">
        <span className="mono">{clock(rec.elapsed)}</span>
        <span className="eq" aria-hidden="true">
          {Array.from({ length: 14 }, (_, i) => (
            <i key={i} style={{ animationDelay: `${(i * 0.13) % 1}s` }} />
          ))}
        </span>
        <span className="lc-open">
          Open <ChevronRight />
        </span>
      </div>
    </button>
  );
}

function LiveBotCard({ m }: { m: Meeting }) {
  const l = botLabel(m.bot!);
  const recording = m.bot!.code === "in_call_recording";
  return (
    <button className={`live-card ${l.tone === "warn" ? "warn" : ""}`} onClick={() => go("m/" + m.id)}>
      <div className="lc-top">
        <SourceBadge m={m} />
        {recording ? (
          <span className="live-pill">
            <i />
            LIVE
          </span>
        ) : (
          <span className="live-pill wait">{l.tone === "warn" ? "ACTION NEEDED" : "JOINING"}</span>
        )}
      </div>
      <b className="lc-title">{m.title}</b>
      <div className="lc-bottom">
        <span>{l.text}</span>
        <span className="lc-open">
          Open <ChevronRight />
        </span>
      </div>
    </button>
  );
}

function UpcomingRow({ m }: { m: Meeting }) {
  const at = new Date(m.bot?.joinAt || m.createdAt);
  return (
    <li className="up-row">
      <button className="up-when" onClick={() => go("m/" + m.id)}>
        <small>{at.toLocaleDateString(undefined, { weekday: "short" }).toUpperCase()}</small>
        <b className="mono">{at.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</b>
      </button>
      <button className="up-main" onClick={() => go("m/" + m.id)}>
        <b>{m.title}</b>
        <span>
          <SourceBadge m={m} /> · {dayLabel(at.toISOString())}
        </span>
      </button>
      <button
        className="switch on"
        role="switch"
        aria-checked="true"
        aria-label="Notetaker will join — turn off to cancel"
        title="Notetaker will join. Turn off to cancel."
        onClick={() => {
          if (!confirm(`Cancel the notetaker for “${m.title}”?`)) return;
          cancelBot(m)
            .then(() => toast("Notetaker cancelled"))
            .catch((e) => toast(e.message, "error"));
        }}
      >
        <i />
      </button>
    </li>
  );
}

function Features() {
  const list: [React.ReactNode, string, string][] = [
    [<Mic />, "Live transcript", "Words appear while people talk, saved every few seconds."],
    [<Users />, "Who said what", "Speakers are told apart automatically. Rename them once."],
    [<FileText />, "Summary & outline", "A short brief, chapters with timestamps, decisions and open questions."],
    [<ListChecks />, "Action items", "Owners and due dates, collected across every meeting."],
    [<Sparkles />, "Ask AI", "“What did we promise the client?” — answers cite the moment."],
    [<Highlighter />, "Highlights & comments", "Mark key moments while recording or afterwards."],
    [<Bot />, "Notetaker for calls", "Send it into a Zoom, Meet or Teams call only when you say so."],
    [<Languages />, "Export anything", "Word, PDF, ZIP, subtitles, audio — or everything at once."],
  ];
  return (
    <div className="features card">
      <p className="features-lede">Your first meeting is one tap away. Here's what you get from every recording:</p>
      <ul>
        {list.map(([icon, title, body]) => (
          <li key={title}>
            <span className="f-icon">{icon}</span>
            <span>
              <b>{title}</b>
              <small>{body}</small>
            </span>
          </li>
        ))}
      </ul>
      <button className="btn btn-rec btn-block" onClick={() => go("record")}>
        <i className="rec-dot" /> Record your first meeting
      </button>
    </div>
  );
}

function MeetingRow({ m, query }: { m: Meeting; query: string }) {
  const stats = usePieceStats(m);
  const importing = useImportProgress(m.id);
  const status = statusText(m, stats, importing);
  const match = query.trim()
    ? m.segments.find((s) => s.text.toLowerCase().includes(query.trim().toLowerCase()))
    : undefined;
  const open = m.notes?.actions.filter((a) => !a.done && a.task.trim()).length || 0;
  const hl = m.segments.filter((s) => s.highlight).length;
  const snippet = match ? `“…${excerpt(match.text, query)}…”` : m.notes?.summary || m.segments.slice(0, 2).map((s) => s.text).join(" ");
  return (
    <button className="row" onClick={() => go("m/" + m.id)}>
      <div className="row-top">
        <span className="row-title">
          {m.starred && <Star className="star-on" />}
          {m.title}
        </span>
        <span className="row-time mono">{timeOf(m.createdAt)}</span>
      </div>
      <div className="row-meta">
        <SourceBadge m={m} />
        {m.duration > 0 && <span>{minutes(m.duration)}</span>}
        <AvatarStack m={m} size={22} />
      </div>
      {snippet && <p className="row-snippet">{snippet}</p>}
      {m.peaks.length > 0 && !snippet && <Waveform peaks={m.peaks} bars={72} height={20} className="row-wave" />}
      {(status || open > 0 || hl > 0 || m.tags.length > 0) && (
        <div className="row-foot">
          {status && <span className={`status status-${m.status}`}>{status}</span>}
          {open > 0 && (
            <span className="pill pill-task">
              <ListChecks /> {open}
            </span>
          )}
          {hl > 0 && (
            <span className="pill pill-hl">
              <Highlighter /> {hl}
            </span>
          )}
          {m.tags.slice(0, 2).map((t) => (
            <span key={t} className="pill">
              #{t}
            </span>
          ))}
        </div>
      )}
    </button>
  );
}

function excerpt(text: string, q: string) {
  const i = text.toLowerCase().indexOf(q.trim().toLowerCase());
  return text.slice(Math.max(0, i - 50), i + 90).trim();
}
