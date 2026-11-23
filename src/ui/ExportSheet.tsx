import { useState } from "react";
import { FileArchive, FileText, FileType2, Captions, AudioLines, Copy, NotebookPen, Loader2 } from "lucide-react";
import type { Meeting } from "../lib/types";
import {
  audioFiles,
  baseName,
  canShareFiles,
  deliver,
  docxBlob,
  libraryZip,
  meetingZip,
  pdfBlob,
  srt,
  summaryMarkdown,
  transcriptTxt,
  chatMarkdown,
  notesMarkdown,
} from "../lib/export";
import { Sheet, toast } from "./kit";

const text = (s: string, type = "text/plain") => new Blob([s], { type: type + ";charset=utf-8" });

export function ExportSheet({ open, onClose, meetings }: { open: boolean; onClose: () => void; meetings: Meeting[] }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [withAudio, setWithAudio] = useState(true);
  const [ready, setReady] = useState<{ blob: Blob; name: string } | null>(null);
  const share = canShareFiles();
  const one = meetings.length === 1 ? meetings[0] : null;

  const run = async (label: string, make: () => Promise<{ blob: Blob; name: string } | null>) => {
    setBusy(label);
    try {
      const out = await make();
      if (!out) return;
      // iPhone only opens the share sheet from a fresh tap, so hand over a button.
      if (share) setReady(out);
      else {
        await deliver(out.blob, out.name, false);
        toast(`Downloaded ${out.name}`);
        onClose();
      }
    } catch (e: any) {
      toast(`Export failed: ${e?.message || e}`, "error");
    } finally {
      setBusy(null);
    }
  };

  const Item = ({ id, icon, title, sub, make }: { id: string; icon: React.ReactNode; title: string; sub: string; make: () => Promise<{ blob: Blob; name: string } | null> }) => (
    <button className="export-item" disabled={!!busy} onClick={() => void run(id, make)}>
      <span className="export-icon">{busy === id ? <Loader2 className="spin" /> : icon}</span>
      <span>
        <b>{title}</b>
        <small>{sub}</small>
      </span>
    </button>
  );

  return (
    <Sheet open={open} onClose={() => !busy && (setReady(null), onClose())} title={one ? "Export meeting" : `Export ${meetings.length} meetings`}>
      {ready ? (
        <div className="export-ready">
          <p>
            <b>{ready.name}</b>
            <small>{(ready.blob.size / 1024 / 1024).toFixed(ready.blob.size > 1e6 ? 1 : 2)} MB · ready</small>
          </p>
          <button
            className="btn btn-ink btn-xl btn-block"
            onClick={async () => {
              const how = await deliver(ready.blob, ready.name);
              if (how !== "cancelled") {
                setReady(null);
                onClose();
                if (how === "downloaded") toast(`Downloaded ${ready.name}`);
              }
            }}
          >
            Save or share
          </button>
          <button className="btn btn-quiet btn-block" onClick={() => void deliver(ready.blob, ready.name, false).then(() => toast("Downloaded"))}>
            Download instead
          </button>
          <button className="link" onClick={() => setReady(null)}>
            ← Other formats
          </button>
        </div>
      ) : (<>
      {share && (
        <p className="sheet-note">
          Your share sheet opens next. To save to Google Drive, pick <b>Drive</b>, or <b>Save to Files</b> → Google Drive.
        </p>
      )}
      <label className="check compact">
        <input type="checkbox" checked={withAudio} onChange={(e) => setWithAudio(e.target.checked)} />
        <span className="box" aria-hidden="true" />
        <span>Include audio in the ZIP</span>
      </label>
      <div className="export-list">
        {one ? (
          <>
            <Item id="zip" icon={<FileArchive />} title="Everything (ZIP)" sub={`Summary, transcript, captions, highlights, notes, AI chat, Word, PDF${withAudio ? ", audio" : ""}`} make={async () => ({ blob: await meetingZip(one, withAudio), name: baseName(one) + ".zip" })} />
            <Item id="docx" icon={<FileType2 />} title="Word document" sub="Summary, outline, actions, highlights, notes, chat and transcript" make={async () => ({ blob: await docxBlob(one), name: baseName(one) + ".docx" })} />
            <Item id="pdf" icon={<FileText />} title="PDF" sub="Same as Word, ready to send" make={async () => ({ blob: await pdfBlob(one), name: baseName(one) + ".pdf" })} />
            <Item id="audio" icon={<AudioLines />} title="Audio" sub="The original recording" make={async () => {
              const files = await audioFiles(one);
              if (!files.length) {
                toast("There's no audio saved for this meeting.", "error");
                return null;
              }
              const f = files[0];
              return { blob: f.blob, name: `${baseName(one)} - ${f.name}` };
            }} />
            <Item id="txt" icon={<FileText />} title="Transcript (.txt)" sub="Speaker names and timestamps" make={async () => ({ blob: text(transcriptTxt(one)), name: baseName(one) + " - transcript.txt" })} />
            <Item id="srt" icon={<Captions />} title="Captions (.srt)" sub="For video editors and YouTube" make={async () => ({ blob: text(srt(one)), name: baseName(one) + ".srt" })} />
            <Item id="md" icon={<NotebookPen />} title="Summary + notes + chat (Markdown)" sub="Paste into Notion, Docs, or Obsidian" make={async () => ({ blob: text([summaryMarkdown(one), notesMarkdown(one), chatMarkdown(one)].join("\n\n---\n\n"), "text/markdown"), name: baseName(one) + ".md" })} />
            <button
              className="export-item"
              disabled={!!busy}
              onClick={() =>
                void navigator.clipboard.writeText(summaryMarkdown(one)).then(
                  () => (toast("Summary copied"), onClose()),
                  () => toast("Copy failed", "error"),
                )
              }
            >
              <span className="export-icon">
                <Copy />
              </span>
              <span>
                <b>Copy summary</b>
                <small>Summary, action items and outline as text</small>
              </span>
            </button>
          </>
        ) : (
          <Item id="all" icon={<FileArchive />} title={`All ${meetings.length} meetings (ZIP)`} sub={`A folder per meeting with every format${withAudio ? " and audio (can be large)" : ""}`} make={async () => ({ blob: await libraryZip(meetings, withAudio), name: `Recapp export ${new Date().toISOString().slice(0, 10)}.zip` })} />
        )}
      </div>
      </>)}
    </Sheet>
  );
}
