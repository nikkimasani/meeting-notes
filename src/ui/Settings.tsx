import { useEffect, useState } from "react";
import { ChevronLeft, FileArchive, Monitor, Moon, Sun, Bot } from "lucide-react";
import { botConfigured } from "../lib/bot";
import { BotSheet } from "./BotSheet";
import { db } from "../lib/db";
import { useMeetings } from "../lib/store";
import { back } from "./kit";
import { ExportSheet } from "./ExportSheet";

export function SettingsScreen() {
  const meetings = useMeetings();
  const [theme, setTheme] = useState(localStorage.getItem("sd-theme") || "system");
  const [language, setLanguage] = useState(localStorage.getItem("sd-language") || "auto");
  const [usage, setUsage] = useState<{ usage?: number; quota?: number } | undefined>();
  const [persisted, setPersisted] = useState<boolean | null>(null);
  const [exportOpen, setExportOpen] = useState(false);
  const [botReady, setBotReady] = useState<boolean | null>(null);
  const [botOpen, setBotOpen] = useState(false);
  useEffect(() => {
    void db.estimate().then(setUsage);
    void botConfigured().then(setBotReady);
    void navigator.storage?.persisted?.().then(setPersisted).catch(() => setPersisted(null));
  }, []);
  const pick = (t: string) => {
    setTheme(t);
    localStorage.setItem("sd-theme", t);
    document.documentElement.dataset.theme = t;
  };
  const mb = (n?: number) => (n ? (n / 1024 / 1024 >= 1024 ? `${(n / 1024 / 1024 / 1024).toFixed(1)} GB` : `${Math.round(n / 1024 / 1024)} MB`) : "—");
  const totalMin = Math.round(meetings.reduce((n, m) => n + m.duration, 0) / 60);
  return (
    <div className="settings">
      <header className="bar">
        <button className="back" onClick={() => back("")}>
          <ChevronLeft /> <span>Meetings</span>
        </button>
      </header>
      <h1 className="page-title">
        <span className="hl">Settings</span>
      </h1>

      <section className="set">
        <h2 className="kicker">Export</h2>
        <button className="set-row" onClick={() => setExportOpen(true)} disabled={!meetings.length}>
          <FileArchive />
          <span>
            <b>Export everything</b>
            <small>
              {meetings.length} meetings · {totalMin} min · every format in one ZIP
            </small>
          </span>
        </button>
      </section>

      <section className="set">
        <h2 className="kicker">Appearance</h2>
        <div className="seg3">
          {(
            [
              ["system", "System", <Monitor key="m" />],
              ["light", "Light", <Sun key="s" />],
              ["dark", "Dark", <Moon key="d" />],
            ] as const
          ).map(([k, label, icon]) => (
            <button key={k} className={theme === k ? "on" : ""} onClick={() => pick(k)}>
              {icon}
              {label}
            </button>
          ))}
        </div>
      </section>

      <section className="set">
        <h2 className="kicker">Transcription</h2>
        <label className="field">
          <span>Default language</span>
          <select
            value={language}
            onChange={(e) => {
              setLanguage(e.target.value);
              localStorage.setItem("sd-language", e.target.value);
            }}
          >
            <option value="auto">Detect automatically</option>
            <option value="en">English</option>
            <option value="es">Spanish</option>
            <option value="fr">French</option>
            <option value="de">German</option>
            <option value="pt">Portuguese</option>
            <option value="hi">Hindi</option>
            <option value="ja">Japanese</option>
            <option value="zh">Chinese</option>
          </select>
        </label>
        <p className="quiet-note">Speakers are detected automatically. Rename them from any meeting and the names carry into exports and chat.</p>
      </section>

      <section className="set">
        <h2 className="kicker">Meeting bot</h2>
        <div className="set-row static">
          <Bot />
          <span>
            <b>Notetaker for Teams, Zoom and Meet</b>
            <small>
              {botReady === null
                ? "Checking…"
                : botReady
                  ? "Ready. It only joins a call when you send it — never automatically."
                  : "Not set up: sign in at vexa.ai with Google, copy your API key, and add it as VEXA_API_KEY in Vercel (meeting-notes → Settings → Environment Variables), then redeploy."}
            </small>
          </span>
        </div>
        {botReady && (
          <button className="btn btn-quiet btn-sm" onClick={() => setBotOpen(true)}>
            <Bot /> Send notetaker to a call
          </button>
        )}
        <BotSheet open={botOpen} onClose={() => setBotOpen(false)} />
      </section>

      <section className="set">
        <h2 className="kicker">Storage</h2>
        <div className="set-row static">
          <span>
            <b>{mb(usage?.usage)} used on this device</b>
            <small>
              {persisted ? "Protected from automatic clean-up." : "Your browser may clear data if the device runs low on space — export regularly."} Audio stays on this device; transcription sends audio to OpenAI and nothing is kept on the server.
            </small>
          </span>
        </div>
      </section>

      <p className="fine center">Recapp · v4 · Created by Nikki</p>
      <ExportSheet open={exportOpen} onClose={() => setExportOpen(false)} meetings={meetings} />
    </div>
  );
}
