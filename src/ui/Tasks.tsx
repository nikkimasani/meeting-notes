import { useMemo, useState } from "react";
import { Check, Copy, ListChecks, ArrowUpRight } from "lucide-react";
import { store, useMeetings } from "../lib/store";
import type { ActionItem, Meeting } from "../lib/types";
import { Empty, clock, dayLabel, go, toast } from "./kit";

type View = "open" | "done" | "all";

export function toggleTask(m: Meeting, a: ActionItem) {
  store.update(m.id, (x) => ({
    notes: x.notes && { ...x.notes, actions: x.notes.actions.map((t) => (t.id === a.id ? { ...t, done: !t.done } : t)) },
  }));
}

export function TaskRow({ m, a, showMeeting = true }: { m: Meeting; a: ActionItem; showMeeting?: boolean }) {
  return (
    <li className={`task-row ${a.done ? "done" : ""}`}>
      <button className="task-box" aria-label={a.done ? "Mark not done" : "Mark done"} aria-pressed={a.done} onClick={() => toggleTask(m, a)}>
        {a.done && <Check />}
      </button>
      <div className="task-text">
        <p>{a.task}</p>
        <div className="task-meta">
          {a.owner && <span className="chip chip-owner">@{a.owner}</span>}
          {a.due && <span className="chip chip-due">Due {a.due}</span>}
          {showMeeting && (
            <button className="task-from" onClick={() => go(`m/${m.id}`)}>
              {m.title}
              {a.start !== null && <span className="mono"> · {clock(a.start)}</span>}
              <ArrowUpRight />
            </button>
          )}
        </div>
      </div>
    </li>
  );
}

export function TasksScreen() {
  const meetings = useMeetings();
  const [view, setView] = useState<View>("open");
  const all = useMemo(
    () => meetings.flatMap((m) => (m.notes?.actions || []).filter((a) => a.task.trim()).map((a) => ({ m, a }))),
    [meetings],
  );
  const openN = all.filter((x) => !x.a.done).length;
  const doneN = all.length - openN;
  const shown = all.filter((x) => (view === "open" ? !x.a.done : view === "done" ? x.a.done : true));
  const groups = useMemo(() => {
    const out: { m: Meeting; items: ActionItem[] }[] = [];
    for (const x of shown) {
      const g = out.find((o) => o.m.id === x.m.id);
      if (g) g.items.push(x.a);
      else out.push({ m: x.m, items: [x.a] });
    }
    return out;
  }, [shown]);
  const copy = () => {
    const text = groups
      .map((g) => `${g.m.title}\n${g.items.map((a) => `- [${a.done ? "x" : " "}] ${a.task}${a.owner ? ` (@${a.owner})` : ""}${a.due ? ` — due ${a.due}` : ""}`).join("\n")}`)
      .join("\n\n");
    void navigator.clipboard.writeText(text).then(() => toast("Copied to clipboard"));
  };
  const pct = all.length ? Math.round((doneN / all.length) * 100) : 0;

  return (
    <div className="tasks-screen">
      <header className="top-head">
        <h1 className="page-title">
          <span className="hl">Action items</span>
        </h1>
        {shown.length > 0 && (
          <button className="icon-btn" aria-label="Copy list" title="Copy list" onClick={copy}>
            <Copy />
          </button>
        )}
      </header>
      <p className="lede">Every next step from every meeting, with who owns it and when it's due.</p>

      <div className="task-progress">
        <div className="tp-num">
          <b>{openN}</b>
          <span>open</span>
        </div>
        <div className="tp-num">
          <b>{doneN}</b>
          <span>done</span>
        </div>
        <div className="tp-bar" aria-label={`${pct}% complete`}>
          <i style={{ width: pct + "%" }} />
          <span className="mono">{pct}%</span>
        </div>
      </div>

      <div className="filters" role="group" aria-label="Show">
        {(
          [
            ["open", `Open ${openN}`],
            ["done", `Done ${doneN}`],
            ["all", `All ${all.length}`],
          ] as [View, string][]
        ).map(([k, label]) => (
          <button key={k} className={view === k ? "on" : ""} onClick={() => setView(k)}>
            {label}
          </button>
        ))}
      </div>

      {groups.length ? (
        <div className="task-groups">
          {groups.map(({ m, items }) => (
            <section key={m.id} className="task-group card">
              <button className="tg-head" onClick={() => go(`m/${m.id}`)}>
                <span>
                  <b>{m.title}</b>
                  <small>
                    {dayLabel(m.createdAt)} · {new Date(m.createdAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
                  </small>
                </span>
                <ArrowUpRight />
              </button>
              <ul className="task-list">
                {items.map((a) => (
                  <TaskRow key={a.id} m={m} a={a} showMeeting={false} />
                ))}
              </ul>
            </section>
          ))}
        </div>
      ) : (
        <Empty
          icon={<ListChecks />}
          title={all.length ? (view === "open" ? "All caught up" : "Nothing here yet") : "No action items yet"}
          body={
            all.length
              ? view === "open"
                ? "Every action item is checked off."
                : "Check off a task and it moves here."
              : "When someone commits to something in a meeting, it lands here with the owner, due date and the moment it was said."
          }
          action={
            !all.length ? (
              <button className="btn btn-rec" onClick={() => go("record")}>
                <i className="rec-dot" /> Record a meeting
              </button>
            ) : undefined
          }
        />
      )}
    </div>
  );
}
