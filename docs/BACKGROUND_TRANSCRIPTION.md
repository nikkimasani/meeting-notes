# Background transcription setup

Background transcription is durable and opt-in. The existing `/api/transcribe` endpoint remains available as the unsigned/synchronous fallback.

## Architecture

1. The signed-in client converts audio to one-minute, 16 kHz mono WAV chunks.
2. It uploads each chunk to the private `meeting-transcription-chunks` bucket under `<user-id>/<meeting-id>/...`.
3. `POST /api/transcription-jobs/create` creates an idempotent job and chunk manifest.
4. `/api/transcription-jobs/process` claims chunks atomically, transcribes them, and checkpoints each result. Failed transient calls retry after exponential backoff; a worker crash is recovered when its three-minute lease expires.
5. `GET /api/transcription-jobs/status?id=<job-id>` returns progress and completed output. `GET /api/transcription-jobs/usage?month=YYYY-MM` returns minutes and estimated transcription spend.

No browser must remain open after all chunks and the job manifest have uploaded.

## One-time setup

1. Run `supabase/migrations/202610070001_background_transcription.sql` in the Supabase SQL editor.
2. Add these Vercel production variables:
   - `OPENAI_API_KEY`
   - `SUPABASE_URL` (for example `https://<project-ref>.supabase.co`)
   - `SUPABASE_ANON_KEY`
   - `SUPABASE_SERVICE_ROLE_KEY` (server only; never use a `VITE_` prefix)
   - `CRON_SECRET` (a long random value; Vercel sends it as `Authorization: Bearer ...`)
3. Redeploy Vercel. Confirm `/api/transcription-jobs/process` appears in Functions and the cron is enabled. On plans that do not support five-minute cron frequency, invoke this endpoint from a trusted scheduler with the same bearer secret.

## Client contract

Upload chunks with the user's Supabase access token, then create a job:

```http
POST /api/transcription-jobs/create
Authorization: Bearer <supabase-access-token>
Idempotency-Key: <user-id>:<meeting-id>:v1
Content-Type: application/json

{
  "meetingId": "local-meeting-id",
  "language": "auto",
  "chunks": [
    { "storagePath": "<user-id>/<meeting-id>/000.wav", "durationSeconds": 60, "bytes": 1920044, "sha256": "..." }
  ]
}
```

The same idempotency key always returns the original job, so network retries cannot duplicate spend. Poll status every 10–20 seconds while the app is open; otherwise reload it on the next launch. For `partial` or `failed`, the original cloud chunks are retained and a new job can be submitted with a versioned idempotency key after correcting the cause.

`segments` is an array of chunk envelopes. Offset segment timestamps by the sum of preceding `durationSeconds` values when presenting the unified transcript.

## Operations

- Inspect structured Vercel events `transcription_chunk_completed`, `transcription_chunk_failed`, and `transcription_worker_failed` using the returned request id.
- Four chunks are processed per worker invocation to stay within the function duration budget.
- Chunks retry at most four times; non-retryable OpenAI errors fail immediately.
- Usage cost is an estimate derived from audio duration and the successful model. Confirm invoices in the OpenAI usage dashboard.
- Add a Supabase Storage lifecycle rule after choosing a retention period. Do not delete chunks until the job is complete and the retained original recording has been verified.
