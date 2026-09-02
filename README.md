# Meeting Notes PWA

A privacy-first meeting recorder, live transcript, summary, and action-item workspace. Data stays in the current browser using local storage.

## Run

```bash
npm install
npm run dev
```

## Deploy

- Vercel: import the repository and use `npm run build`, output `dist`.
- Cloudflare Pages: connect the repository and use `npm run build`, output `dist`.

Microphone access requires HTTPS. Live transcription depends on browser Speech Recognition support. Chrome and Edge provide the broadest support. Imported recordings can be played back while the transcript is added manually.
