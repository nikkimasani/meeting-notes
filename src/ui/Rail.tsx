import { useSyncExternalStore } from "react";
import { AudioLines, MessageCircle, Settings, Mic, ListChecks } from "lucide-react";
import { recorder } from "../lib/recorder";
import { useMeetings } from "../lib/store";
import { clock, go, type Route } from "./kit";

export function useRecorder() {
  return useSyncExternalStore(recorder.subscribe, recorder.getSnapshot);
}

export function useOpenTaskCount() {
  const meetings = useMeetings();
  return meetings.reduce((n, m) => n + (m.notes?.actions.filter((a) => !a.done && a.task.trim()).length || 0), 0);
}

export function Rail({ route }: { route: Route }) {
  const rec = useRecorder();
  const open = useOpenTaskCount();
  const live = rec.state !== "idle";
  const item = (name: Route["name"], path: string, label: string, icon: React.ReactNode, badge = 0) => {
    const on = route.name === name || (name === "home" && route.name === "meeting");
    return (
      <a
        href={"#/" + path}
        className={`rail-item rail-${name} ${on ? "on" : ""}`}
        aria-current={on ? "page" : undefined}
        onClick={(e) => {
          e.preventDefault();
          go(path);
        }}
      >
        <span className="rail-icon">
          {icon}
          {badge > 0 && <i className="badge">{badge > 99 ? "99+" : badge}</i>}
        </span>
        <span className="rail-label">{label}</span>
      </a>
    );
  };
  return (
    <nav className="rail" aria-label="Main">
      <a
        className="rail-brand"
        href="#/"
        onClick={(e) => {
          e.preventDefault();
          go("");
        }}
      >
        <img src="/recapp-mark.png" alt="" />
        <span>Recapp</span>
      </a>
      <div className="rail-record-slot">
        <button className={`rail-record ${live ? "live" : ""}`} onClick={() => go("record")} aria-label={live ? "Return to recording" : "Record"}>
          {live ? (
            <>
              <i className="rec-dot" />
              <span className="mono">{clock(rec.elapsed)}</span>
            </>
          ) : (
            <>
              <Mic />
              <span className="rail-record-label">Record</span>
            </>
          )}
        </button>
      </div>
      {item("home", "", "Meetings", <AudioLines />)}
      {item("tasks", "tasks", "Tasks", <ListChecks />, open)}
      {item("ask", "ask", "Ask AI", <MessageCircle />)}
      {item("settings", "settings", "Settings", <Settings />)}
    </nav>
  );
}
