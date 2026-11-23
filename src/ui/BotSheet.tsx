import { useEffect, useState } from "react";
import { Bot, Loader2 } from "lucide-react";
import { botConfigured, platformOf, sendBot } from "../lib/bot";
import { Sheet, go, toast } from "./kit";

export function BotSheet({ open, onClose, mode = "now" }: { open: boolean; onClose: () => void; mode?: "now" | "later" }) {
  const [url, setUrl] = useState("");
  const [title, setTitle] = useState("");
  const [when, setWhen] = useState<"now" | "later">("now");
  const [at, setAt] = useState("");
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState<boolean | null>(null);
  const [consent, setConsent] = useState(false);
  useEffect(() => {
    if (open) {
      setWhen(mode);
      void botConfigured().then(setReady);
    }
  }, [open, mode]);
  const platform = platformOf(url);
  const submit = async () => {
    setBusy(true);
    try {
      const id = await sendBot({ url, title, joinAt: when === "later" && at ? new Date(at).toISOString() : null });
      toast(when === "later" ? "Notetaker scheduled" : "Notetaker is on its way");
      setUrl("");
      setTitle("");
      onClose();
      go("m/" + id);
    } catch (e: any) {
      toast(e.message, "error");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Sheet open={open} onClose={() => !busy && onClose()} title="Send a notetaker">
      <p className="sheet-note">
        A bot named <b>Recapp Notetaker</b> joins only this call, records it, and the transcript and notes land here. It never joins anything on its own.
      </p>
      {ready === false ? (
        <div className="banner banner-warn">
          <span>
            The notetaker isn't set up yet. Sign in at vexa.ai with Google, copy your API key, add it as <b>VEXA_API_KEY</b> in Vercel (meeting-notes → Settings → Environment Variables), then redeploy.
          </span>
        </div>
      ) : (
        <form
          className="sheet-form"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <label className="field">
            <span>Meeting link</span>
            <input
              inputMode="url"
              autoComplete="off"
              placeholder="Paste a Teams, Zoom or Meet link"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              aria-label="Meeting link"
            />
            {url && <small className={platform && platform !== "Webex" ? "ok-note" : "warn-note"}>{platform && platform !== "Webex" ? `${platform} link` : "Paste a Teams, Zoom or Google Meet link"}</small>}
          </label>
          <label className="field">
            <span>Title (optional)</span>
            <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Partner sync" />
          </label>
          <div className="seg2" role="group" aria-label="When">
            <button type="button" className={when === "now" ? "on" : ""} onClick={() => setWhen("now")}>
              Join now
            </button>
            <button type="button" className={when === "later" ? "on" : ""} onClick={() => setWhen("later")}>
              Schedule
            </button>
          </div>
          {when === "later" && (
            <label className="field">
              <span>Join at</span>
              <input type="datetime-local" value={at} onChange={(e) => setAt(e.target.value)} />
            </label>
          )}
          <label className="check compact">
            <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
            <span className="box" aria-hidden="true" />
            <span>People in this call will see the notetaker and know it's recording.</span>
          </label>
          <button className="btn btn-ink btn-block btn-xl" disabled={busy || !platform || platform === "Webex" || !consent || (when === "later" && !at) || ready === null}>
            {busy ? <Loader2 className="spin" /> : <Bot />} {when === "later" ? "Schedule notetaker" : "Send notetaker now"}
          </button>
          <p className="fine">Costs about $0.30 per hour the bot is in the call (billed by Vexa; new accounts get $5 free). In Teams, someone may need to admit it from the lobby.</p>
        </form>
      )}
    </Sheet>
  );
}
