import { useEffect, useRef, useState } from "react";
import { ChevronLeft, Highlighter, Pause, Play, Square, WifiOff, Mic, Bot } from "lucide-react";
import { BotSheet } from "./BotSheet";
import { recorder } from "../lib/recorder";
import { newMeeting, store, useMeeting } from "../lib/store";
import { speakerName } from "../lib/ai";
import { Avatar, back, clock, go, toast, useOnline, usePieceStats } from "./kit";
import { useRecorder } from "./Rail";

export function RecordScreen() {
  const rec = useRecorder();
  return rec.state === "idle" || rec.state === "starting" ? <Setup starting={rec.state === "starting"} error={rec.error} /> : <Live />;
}

function Setup({ starting, error }: { starting: boolean; error: string }) {
  const [title, setTitle] = useState("");
  const [consent, setConsent] = useState(localStorage.getItem("sd-consent-remember") === "1");
  const [language, setLanguage] = useState(localStorage.getItem("sd-language") || "auto");
  const [botOpen, setBotOpen] = useState(false);
  const start = async () => {
    localStorage.setItem("sd-language", language);
    const m = newMeeting({ language, ...(title.trim() ? { title: title.trim(), titleIsAuto: false } : {}) });
    try {
      await recorder.start(m);
    } catch (e: any) {
      toast(e.message, "error");
    }
  };
  return (
    <div className="rec-setup">
      <header className="bar">
        <button className="back" onClick={() => back("")}>
          <ChevronLeft /> Back
        </button>
      </header>
      <div className="rec-setup-body">
        <div className="mic-orb" aria-hidden="true">
          <Mic />
        </div>
        <h1 className="display">New recording</h1>
        <p className="lede">Words appear as people talk. Everything is saved on this phone every few seconds, so nothing is lost if the app closes.</p>
        <label className="field">
          <span>Title (optional)</span>
          <input value={title} placeholder="e.g. Weekly marketing sync" onChange={(e) => setTitle(e.target.value)} />
        </label>
        <label className="field">
          <span>Language</span>
          <select value={language} onChange={(e) => setLanguage(e.target.value)}>
            <option value="auto">Detect automatically</option>
            <option value="en">English</option>
            <option value="es">Spanish</option>
            <option value="fr">French</option>
            <option value="de">German</option>
            <option value="pt">Portuguese</option>
            <option value="it">Italian</option>
            <option value="hi">Hindi</option>
            <option value="ja">Japanese</option>
            <option value="ko">Korean</option>
            <option value="zh">Chinese</option>
          </select>
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={consent}
            onChange={(e) => {
              setConsent(e.target.checked);
              localStorage.setItem("sd-consent-remember", e.target.checked ? "1" : "0");
            }}
          />
          <span className="box" aria-hidden="true" />
          <span>Everyone in this conversation knows it's being recorded.</span>
        </label>
        {error && <p className="inline-error">{error}</p>}
        <button className="btn btn-rec btn-xl" disabled={!consent || starting} onClick={start}>
          <i className="rec-dot" /> {starting ? "Starting…" : "Start recording"}
        </button>
        <p className="fine">Tip: keep the screen on and the app open while recording. Your phone won't sleep while this screen is up.</p>
        <button className="bot-entry" onClick={() => setBotOpen(true)}>
          <Bot />
          <span>
            <b>On a Teams, Zoom or Meet call?</b>
            <small>Send a notetaker to join and record it for you — only when you ask.</small>
          </span>
        </button>
        <BotSheet open={botOpen} onClose={() => setBotOpen(false)} />
      </div>
    </div>
  );
}

function Live() {
  const rec = useRecorder();
  const m = useMeeting(rec.meetingId || undefined);
  const stats = usePieceStats(m);
  const online = useOnline();
  const list = useRef<HTMLDivElement | null>(null);
  const [follow, setFollow] = useState(true);
  const [marked, setMarked] = useState(0);

  useEffect(() => {
    if (follow && list.current) list.current.scrollTop = list.current.scrollHeight;
  }, [m?.segments.length, follow]);

  if (!m) return null;
  const behind = stats ? stats.pending : 0;
  const stop = async () => {
    const id = await recorder.stop();
    if (id) go("m/" + id + "?tab=transcript", true);
  };
  const mark = () => {
    store.update(m.id, (x) => ({ marks: [...(x.marks || []), rec.elapsed] }));
    setMarked(Date.now());
    toast("Highlighted — this moment will be marked in the transcript");
  };

  return (
    <div className="live">
      <header className="live-head">
        <div className="live-status">
          <i className={`rec-dot ${rec.state === "paused" ? "paused" : ""}`} />
          <span className="mono live-clock">{clock(rec.elapsed)}</span>
          <Meter level={rec.level} active={rec.state === "recording"} />
        </div>
        <input
          className="live-title"
          aria-label="Meeting title"
          value={m.title}
          onChange={(e) => store.update(m.id, { title: e.target.value, titleIsAuto: false }, { debounce: true })}
        />
      </header>

      {!online && (
        <div className="notice">
          <WifiOff /> Offline — audio is still being saved and will transcribe when you reconnect.
        </div>
      )}
      {rec.state === "interrupted" && (
        <div className="notice notice-warn">
          <span>The microphone was interrupted (a call, Siri, or another app). Everything up to now is saved.</span>
          <button className="btn btn-ink btn-sm" onClick={() => void recorder.reconnect()}>
            Resume recording
          </button>
        </div>
      )}
      {rec.error && <p className="inline-error">{rec.error}</p>}

      <div
        className="live-transcript"
        ref={list}
        onScroll={(e) => {
          const el = e.currentTarget;
          setFollow(el.scrollHeight - el.scrollTop - el.clientHeight < 80);
        }}
      >
        {m.segments.length === 0 && (
          <p className="live-hint">Start talking. The first lines appear about 15–30 seconds in, then keep flowing as you speak.</p>
        )}
        {m.segments.map((s, i) => {
          const prev = m.segments[i - 1];
          const same = prev && prev.speaker === s.speaker;
          return (
            <div key={s.id} className={`line ${same ? "cont" : ""} ${s.highlight ? "is-hl" : ""}`}>
              {!same && (
                <div className="line-who">
                  <Avatar id={s.speaker} name={speakerName(m, s.speaker)} size={26} />
                  <b>{speakerName(m, s.speaker)}</b>
                  <span className="mono">{clock(s.start)}</span>
                </div>
              )}
              <p>
                <span className="mark">{s.text}</span>
              </p>
            </div>
          );
        })}
        {rec.state === "recording" && (
          <div className="listening">
            <span className="dots">
              <i />
              <i />
              <i />
            </span>
            {behind > 1 ? `Transcribing… (${behind} parts waiting${online ? "" : " for connection"})` : "Listening"}
          </div>
        )}
      </div>

      <footer className="live-controls">
        <button className={`ctl ${Date.now() - marked < 1500 ? "flash" : ""}`} onClick={mark} disabled={rec.state !== "recording"}>
          <Highlighter />
          <span>Highlight</span>
        </button>
        <button className="ctl-stop" onClick={stop} disabled={rec.state === "stopping"} aria-label="Stop and save">
          <Square />
        </button>
        <button className="ctl" onClick={() => (rec.state === "paused" ? recorder.resume() : recorder.pause())} disabled={rec.state === "interrupted" || rec.state === "stopping"}>
          {rec.state === "paused" ? <Play /> : <Pause />}
          <span>{rec.state === "paused" ? "Resume" : "Pause"}</span>
        </button>
      </footer>
    </div>
  );
}

function Meter({ level, active }: { level: number; active: boolean }) {
  const bars = 5;
  return (
    <span className="meter" aria-hidden="true">
      {Array.from({ length: bars }, (_, i) => (
        <i key={i} className={active && level > (i + 0.5) / bars ? "on" : ""} />
      ))}
    </span>
  );
}
