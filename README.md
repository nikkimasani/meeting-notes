# Meeting Notes PWA

A privacy-focused meeting workspace for recording, speaker-aware transcription, AI summaries, action items, decisions, follow-up emails, searchable organization, and cross-device sync.

## Features

- Mobile-safe recording with consent, pause, wake lock, and upload safeguards
- Speaker diarization with timestamped segments and editable speaker names
- AI summaries, decisions, risks, open questions, action items, and follow-up agendas
- Editable action owners, due dates, priorities, and completion tracking
- Meeting types, attendees, agendas, folders, tags, favorites, archive, and analytics
- Search, sharing, follow-up email drafting, calendar export, Markdown, JSON, CSV, text, and print-to-PDF
- Optional Supabase account sync and installable PWA behavior

## Run

```bash
npm install
npm run dev
```

## Deploy

- Vercel: import the repository, run `npm run build`, and publish `dist`.
- Set `OPENAI_API_KEY` in Vercel for transcription and AI features.

Microphone access requires HTTPS.
