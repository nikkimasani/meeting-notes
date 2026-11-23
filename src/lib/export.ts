import { db } from "./db";
import { wavBlob } from "./audio";
import { speakerName, stamp, transcriptText } from "./ai";
import type { Meeting } from "./types";

const safe = (s: string) => s.replace(/[\\/:*?"<>|]+/g, "-").replace(/\s+/g, " ").trim().slice(0, 80) || "Meeting";
const dateLabel = (m: Meeting) =>
  new Date(m.createdAt).toLocaleString(undefined, { dateStyle: "full", timeStyle: "short" });
const ymd = (m: Meeting) => new Date(m.createdAt).toISOString().slice(0, 10);
export const baseName = (m: Meeting) => `${ymd(m)} ${safe(m.title)}`;

// ---------- Text formats ----------
export function summaryMarkdown(m: Meeting) {
  const n = m.notes;
  const out = [`# ${m.title}`, `_${dateLabel(m)} · ${Math.round(m.duration / 60)} min_`, ""];
  if (n?.summary) out.push("## Summary", n.summary, "");
  if (n?.actions.length)
    out.push(
      "## Action items",
      ...n.actions.map((a) => `- [${a.done ? "x" : " "}] ${a.task}${a.owner ? ` — ${a.owner}` : ""}${a.due ? ` (due ${a.due})` : ""}`),
      "",
    );
  if (n?.outline.length) {
    out.push("## Outline");
    for (const s of n.outline) out.push(`### ${s.heading} (${stamp(s.start)})`, ...s.bullets.map((b) => `- ${b}`), "");
  }
  if (n?.decisions.length) out.push("## Decisions", ...n.decisions.map((d) => `- ${d}`), "");
  if (n?.openQuestions.length) out.push("## Open questions", ...n.openQuestions.map((d) => `- ${d}`), "");
  if (m.tags.length) out.push(`Tags: ${m.tags.map((t) => "#" + t).join(" ")}`, "");
  return out.join("\n");
}
export const notesMarkdown = (m: Meeting) => `# Notes — ${m.title}\n\n${m.userNotes || "_No notes._"}\n`;
export function highlightsMarkdown(m: Meeting) {
  const hs = m.segments.filter((s) => s.highlight || s.comment);
  return [
    `# Highlights — ${m.title}`,
    "",
    ...(hs.length
      ? hs.map(
          (s) => `- **${stamp(s.start)} ${speakerName(m, s.speaker)}:** ${s.text}${s.comment ? `\n  > 💬 ${s.comment}` : ""}`,
        )
      : ["_No highlights._"]),
  ].join("\n");
}
export function chatMarkdown(m: Meeting) {
  return [
    `# AI chat — ${m.title}`,
    "",
    ...(m.chat.length
      ? m.chat.map((c) => `**${c.role === "user" ? "You" : "AI"}** · ${new Date(c.at).toLocaleString()}\n\n${c.content}\n`)
      : ["_No questions asked yet._"]),
  ].join("\n");
}
export const transcriptTxt = (m: Meeting) => `${m.title}\n${dateLabel(m)}\n\n${transcriptText(m).replace(/\n/g, "\n\n")}\n`;

const ts = (sec: number, sep: string) => {
  const ms = Math.round((sec % 1) * 1000);
  const s = Math.floor(sec);
  return `${String(Math.floor(s / 3600)).padStart(2, "0")}:${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}${sep}${String(ms).padStart(3, "0")}`;
};
export const srt = (m: Meeting) =>
  m.segments
    .map((s, i) => `${i + 1}\n${ts(s.start, ",")} --> ${ts(Math.max(s.end, s.start + 1), ",")}\n${speakerName(m, s.speaker)}: ${s.text}\n`)
    .join("\n");
export const vtt = (m: Meeting) =>
  "WEBVTT\n\n" +
  m.segments
    .map((s) => `${ts(s.start, ".")} --> ${ts(Math.max(s.end, s.start + 1), ".")}\n<v ${speakerName(m, s.speaker)}>${s.text}\n`)
    .join("\n");
export const jsonExport = (m: Meeting) => JSON.stringify({ ...m, exportedAt: new Date().toISOString(), app: "Recapp" }, null, 2);

// ---------- Word ----------
export async function docxBlob(m: Meeting) {
  const d = await import("docx");
  const { Document, Packer, Paragraph, TextRun, HeadingLevel } = d;
  const P = (text: string, opts: any = {}) => new Paragraph({ children: [new TextRun({ text, ...opts })], spacing: { after: 120 } });
  const H = (text: string, level: any) => new Paragraph({ text, heading: level, spacing: { before: 240, after: 120 } });
  const bullet = (text: string) => new Paragraph({ text, bullet: { level: 0 } });
  const n = m.notes;
  const children: any[] = [
    new Paragraph({ text: m.title, heading: HeadingLevel.TITLE }),
    P(`${dateLabel(m)} · ${Math.round(m.duration / 60)} min`, { color: "666666" }),
  ];
  if (n?.summary) children.push(H("Summary", HeadingLevel.HEADING_1), P(n.summary));
  if (n?.actions.length) {
    children.push(H("Action items", HeadingLevel.HEADING_1));
    n.actions.forEach((a) =>
      children.push(bullet(`${a.done ? "☑" : "☐"} ${a.task}${a.owner ? ` — ${a.owner}` : ""}${a.due ? ` (due ${a.due})` : ""}`)),
    );
  }
  if (n?.outline.length) {
    children.push(H("Outline", HeadingLevel.HEADING_1));
    n.outline.forEach((s) => {
      children.push(H(`${s.heading} · ${stamp(s.start)}`, HeadingLevel.HEADING_3));
      s.bullets.forEach((b) => children.push(bullet(b)));
    });
  }
  if (n?.decisions.length) {
    children.push(H("Decisions", HeadingLevel.HEADING_1));
    n.decisions.forEach((x) => children.push(bullet(x)));
  }
  const hs = m.segments.filter((s) => s.highlight || s.comment);
  if (hs.length) {
    children.push(H("Highlights", HeadingLevel.HEADING_1));
    hs.forEach((s) =>
      children.push(
        new Paragraph({
          children: [
            new TextRun({ text: `${stamp(s.start)} ${speakerName(m, s.speaker)}: `, bold: true }),
            new TextRun({ text: s.text, highlight: s.highlight ? "yellow" : undefined }),
            ...(s.comment ? [new TextRun({ text: `  — ${s.comment}`, italics: true, color: "555555" })] : []),
          ],
          spacing: { after: 120 },
        }),
      ),
    );
  }
  if (m.userNotes.trim()) {
    children.push(H("My notes", HeadingLevel.HEADING_1));
    m.userNotes.split(/\n/).forEach((l) => children.push(P(l)));
  }
  if (m.chat.length) {
    children.push(H("AI chat", HeadingLevel.HEADING_1));
    m.chat.forEach((c) =>
      children.push(
        new Paragraph({
          children: [new TextRun({ text: c.role === "user" ? "You: " : "AI: ", bold: true }), new TextRun(c.content)],
          spacing: { after: 120 },
        }),
      ),
    );
  }
  if (m.segments.length) {
    children.push(H("Transcript", HeadingLevel.HEADING_1));
    m.segments.forEach((s) =>
      children.push(
        new Paragraph({
          children: [
            new TextRun({ text: `${speakerName(m, s.speaker)}  `, bold: true }),
            new TextRun({ text: stamp(s.start), color: "888888", size: 18 }),
          ],
          spacing: { before: 120 },
        }),
        new Paragraph({ children: [new TextRun({ text: s.text, highlight: s.highlight ? "yellow" : undefined })], spacing: { after: 80 } }),
      ),
    );
  }
  const doc = new Document({
    creator: "Recapp",
    title: m.title,
    styles: { default: { document: { run: { font: "Calibri", size: 22 } } } },
    sections: [{ children }],
  });
  return Packer.toBlob(doc);
}

// ---------- PDF ----------
export async function pdfBlob(m: Meeting) {
  const { jsPDF } = await import("jspdf");
  const doc = new jsPDF({ unit: "pt", format: "letter" });
  const W = doc.internal.pageSize.getWidth(),
    H = doc.internal.pageSize.getHeight(),
    M = 56,
    width = W - M * 2;
  let y = M;
  const ensure = (h: number) => {
    if (y + h > H - M) {
      doc.addPage();
      y = M;
    }
  };
  const text = (t: string, size = 11, style: "normal" | "bold" | "italic" = "normal", color = 20, indent = 0) => {
    doc.setFont("helvetica", style);
    doc.setFontSize(size);
    doc.setTextColor(color);
    const lines = doc.splitTextToSize(clean(t), width - indent);
    for (const line of lines) {
      ensure(size * 1.4);
      doc.text(line, M + indent, y);
      y += size * 1.4;
    }
  };
  const heading = (t: string) => {
    y += 10;
    ensure(40);
    text(t, 14, "bold");
    y += 2;
  };
  text(m.title, 22, "bold");
  text(`${dateLabel(m)} · ${Math.round(m.duration / 60)} min`, 10, "normal", 110);
  y += 6;
  const n = m.notes;
  if (n?.summary) {
    heading("Summary");
    text(n.summary);
  }
  if (n?.actions.length) {
    heading("Action items");
    n.actions.forEach((a) => text(`${a.done ? "[x]" : "[ ]"} ${a.task}${a.owner ? ` — ${a.owner}` : ""}${a.due ? ` (due ${a.due})` : ""}`, 11, "normal", 20, 8));
  }
  if (n?.outline.length) {
    heading("Outline");
    n.outline.forEach((s) => {
      text(`${s.heading}  ·  ${stamp(s.start)}`, 11.5, "bold");
      s.bullets.forEach((b) => text(`•  ${b}`, 11, "normal", 40, 10));
      y += 4;
    });
  }
  if (n?.decisions.length) {
    heading("Decisions");
    n.decisions.forEach((d) => text(`•  ${d}`, 11, "normal", 20, 8));
  }
  const hs = m.segments.filter((s) => s.highlight || s.comment);
  if (hs.length) {
    heading("Highlights");
    hs.forEach((s) => {
      text(`${stamp(s.start)}  ${speakerName(m, s.speaker)}: ${s.text}`, 11, "normal", 20, 8);
      if (s.comment) text(`Comment: ${s.comment}`, 10, "italic", 90, 18);
    });
  }
  if (m.userNotes.trim()) {
    heading("My notes");
    text(m.userNotes);
  }
  if (m.chat.length) {
    heading("AI chat");
    m.chat.forEach((c) => {
      text(c.role === "user" ? "You" : "AI", 10, "bold", 80);
      text(c.content, 11, "normal", 20, 0);
      y += 4;
    });
  }
  if (m.segments.length) {
    heading("Transcript");
    m.segments.forEach((s) => {
      text(`${speakerName(m, s.speaker)}   ${stamp(s.start)}`, 9.5, "bold", 90);
      text(s.text, 11);
      y += 3;
    });
  }
  const pages = doc.getNumberOfPages();
  for (let i = 1; i <= pages; i++) {
    doc.setPage(i);
    doc.setFontSize(8.5);
    doc.setTextColor(150);
    doc.text(`Recapp · ${m.title}`, M, H - 28);
    doc.text(`${i} / ${pages}`, W - M, H - 28, { align: "right" });
  }
  return doc.output("blob");
}
// Helvetica in jsPDF only covers Latin-1; swap common typographic characters.
const clean = (s: string) =>
  s
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/[—–]/g, "-")
    .replace(/…/g, "...")
    .replace(/[☐☑💬⚠︎]/g, "")
    .replace(/[^\x00-\xFF]/g, "");

// ---------- Audio ----------
export async function audioFiles(m: Meeting): Promise<{ name: string; blob: Blob }[]> {
  const out: { name: string; blob: Blob }[] = [];
  for (const f of m.audioFiles) {
    const blob = (await db.audio(f.key)) || (await db.chunkedAudio(f.key));
    if (blob?.size) out.push({ name: f.name, blob });
  }
  if (!out.length && m.hasPcm) {
    const parts = await db.allPcm(m.id);
    if (parts.length) out.push({ name: "recording.wav", blob: wavBlob(parts) });
  }
  return out;
}
/** Best single audio track for playback (exactly aligned with the transcript). */
export async function playbackBlob(m: Meeting): Promise<Blob | null> {
  if (m.hasPcm) {
    const parts = await db.allPcm(m.id);
    if (parts.length) return wavBlob(parts);
  }
  const f = m.audioFiles[0];
  if (!f) return null;
  return (await db.audio(f.key)) || (await db.chunkedAudio(f.key));
}

// ---------- ZIP ----------
async function meetingEntries(m: Meeting, includeAudio: boolean, prefix = "") {
  const enc = new TextEncoder();
  const files: Record<string, Uint8Array | [Uint8Array, { level: 0 }]> = {};
  const add = (name: string, data: string | Uint8Array) => (files[prefix + name] = typeof data === "string" ? enc.encode(data) : data);
  add("Summary.md", summaryMarkdown(m));
  add("Transcript.txt", transcriptTxt(m));
  if (m.segments.length) {
    add("Captions.srt", srt(m));
    add("Captions.vtt", vtt(m));
  }
  add("Highlights.md", highlightsMarkdown(m));
  add("Notes.md", notesMarkdown(m));
  add("AI chat.md", chatMarkdown(m));
  add("meeting.json", jsonExport(m));
  add(`${safe(m.title)}.docx`, new Uint8Array(await (await docxBlob(m)).arrayBuffer()));
  add(`${safe(m.title)}.pdf`, new Uint8Array(await (await pdfBlob(m)).arrayBuffer()));
  if (includeAudio)
    for (const a of await audioFiles(m)) files[prefix + "Audio/" + a.name] = [new Uint8Array(await a.blob.arrayBuffer()), { level: 0 }];
  return files;
}
function zip(files: Record<string, any>) {
  return import("fflate").then(
    ({ zip }) =>
      new Promise<Blob>((resolve, reject) =>
        zip(files, { level: 6 }, (err, data) => (err ? reject(err) : resolve(new Blob([data], { type: "application/zip" })))),
      ),
  );
}
export async function meetingZip(m: Meeting, includeAudio = true) {
  return zip(await meetingEntries(m, includeAudio));
}
export async function libraryZip(meetings: Meeting[], includeAudio: boolean, onProgress?: (n: number) => void) {
  const all: Record<string, any> = {};
  const seen = new Set<string>();
  for (let i = 0; i < meetings.length; i++) {
    let folder = baseName(meetings[i]);
    while (seen.has(folder)) folder += " (2)";
    seen.add(folder);
    Object.assign(all, await meetingEntries(meetings[i], includeAudio, folder + "/"));
    onProgress?.((i + 1) / meetings.length);
  }
  all["README.txt"] = new TextEncoder().encode(
    `Recapp export — ${new Date().toLocaleString()}\n${meetings.length} meetings. Each folder has the summary, transcript, captions, highlights, notes, AI chat, Word and PDF documents${includeAudio ? ", and audio" : ""}.\n`,
  );
  return zip(all);
}

// ---------- Delivery ----------
/**
 * Opens the share sheet when the device supports sharing files (iPhone:
 * "Save to Files" → Google Drive, or the Drive app itself). Falls back to a download.
 */
export async function deliver(blob: Blob, filename: string, preferShare = true) {
  const file = new File([blob], filename, { type: blob.type || "application/octet-stream" });
  if (preferShare && navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: filename });
      return "shared";
    } catch (e: any) {
      if (e?.name === "AbortError") return "cancelled";
    }
  }
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement("a"), { href: url, download: filename });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
  return "downloaded";
}
export const canShareFiles = () => {
  try {
    return !!navigator.canShare?.({ files: [new File(["x"], "x.txt", { type: "text/plain" })] });
  } catch {
    return false;
  }
};
