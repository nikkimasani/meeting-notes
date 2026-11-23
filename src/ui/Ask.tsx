import { useEffect, useRef, useState } from "react";
import { ChevronLeft, Copy, Send, Sparkles } from "lucide-react";
import { db } from "../lib/db";
import { askLibrary } from "../lib/ai";
import { useMeetings } from "../lib/store";
import type { ChatMessage } from "../lib/types";
import { Empty, back, toast } from "./kit";
import { RichText } from "./Meeting";

export function AskScreen() {
  const meetings = useMeetings();
  const [history, setHistory] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const end = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    void db.kv<ChatMessage[]>("library-chat").then((h) => h && setHistory(h));
  }, []);
  useEffect(() => {
    end.current?.scrollIntoView({ block: "end" });
  }, [history.length, busy]);
  const usable = meetings.filter((m) => m.segments.length || m.notes);
  const save = (h: ChatMessage[]) => {
    setHistory(h);
    void db.setKv("library-chat", h.slice(-60));
  };
  const ask = async (q: string) => {
    if (!q.trim() || busy) return;
    setDraft("");
    setBusy(true);
    const pending = [...history, { role: "user" as const, content: q.trim(), at: new Date().toISOString() }];
    setHistory(pending);
    try {
      const { user, assistant } = await askLibrary(history, q.trim(), usable);
      save([...history, user, assistant]);
    } catch (e: any) {
      save([...pending, { role: "assistant", content: `⚠︎ ${e.message}`, at: new Date().toISOString() }]);
    } finally {
      setBusy(false);
    }
  };
  const suggestions = [
    "What action items are assigned to me?",
    "Summarize this week's meetings",
    "What decisions did we make recently?",
    "Which meetings mentioned the budget?",
  ];
  return (
    <div className="ask">
      <header className="bar">
        <button className="back" onClick={() => back("")}>
          <ChevronLeft /> <span>Meetings</span>
        </button>
        {history.length > 0 && (
          <button className="link" onClick={() => confirm("Clear this conversation?") && save([])}>
            Clear
          </button>
        )}
      </header>
      <h1 className="page-title">
        <span className="hl">Ask AI</span>
      </h1>
      <p className="lede">Answers come from your {usable.length} transcribed meeting{usable.length === 1 ? "" : "s"}, with the meeting and moment cited.</p>
      {!usable.length ? (
        <Empty icon={<Sparkles />} title="Nothing to search yet" body="Record or import a meeting first. Once it's transcribed, ask anything across all of them." />
      ) : (
        <>
          {history.length === 0 && (
            <div className="suggest">
              {suggestions.map((s) => (
                <button key={s} onClick={() => void ask(s)}>
                  {s}
                </button>
              ))}
            </div>
          )}
          <div className="msgs">
            {history.map((c, i) => (
              <div key={i} className={`msg msg-${c.role}`}>
                {c.role === "assistant" ? <RichText text={c.content} /> : c.content}
                {c.role === "assistant" && (
                  <button className="msg-copy" aria-label="Copy answer" onClick={() => void navigator.clipboard.writeText(c.content).then(() => toast("Copied"))}>
                    <Copy />
                  </button>
                )}
              </div>
            ))}
            {busy && (
              <div className="msg msg-assistant typing">
                <span className="dots">
                  <i />
                  <i />
                  <i />
                </span>
              </div>
            )}
            <div ref={end} />
          </div>
          <form
            className="composer"
            onSubmit={(e) => {
              e.preventDefault();
              void ask(draft);
            }}
          >
            <input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Ask across all meetings" aria-label="Ask across all meetings" />
            <button className="send" disabled={!draft.trim() || busy} aria-label="Send">
              <Send />
            </button>
          </form>
        </>
      )}
    </div>
  );
}
