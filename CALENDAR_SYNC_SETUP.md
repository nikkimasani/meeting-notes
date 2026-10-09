# Calendar sync setup

Said and Done uses its server side calendar API for Google Calendar and Outlook. Calendar changes are synced only for planned meetings in the user's Said and Done agenda. Sync is user initiated; it does not import unrelated events or delete calendar events.

## Provider registrations

Create an OAuth client in Google Cloud and an app registration in Microsoft Entra ID. Configure each as a web application / confidential web client. Add these redirect URIs to both provider registrations (the app returns to the origin where connection was started):

- `https://meeting-notes-nikkimasanis-projects.vercel.app/`
- `https://meeting-notes-git-main-nikkimasanis-projects.vercel.app/`
- `https://meeting-notes-eta-ecru.vercel.app/`
- `https://meeting-notes-cloudflare.pages.dev/`

Google requests `openid`, `email`, and `https://www.googleapis.com/auth/calendar.events`, with offline access. Microsoft requests delegated `User.Read` and `Calendars.ReadWrite`, plus `openid`, `profile`, `email`, and `offline_access`.

## Vercel environment variables

Set these as sensitive environment variables on the `meeting-notes` Vercel project for Production (and Preview if preview deployments are used):

- `GOOGLE_CALENDAR_CLIENT_ID`
- `GOOGLE_CALENDAR_CLIENT_SECRET`
- `MICROSOFT_CALENDAR_CLIENT_ID`
- `MICROSOFT_CALENDAR_CLIENT_SECRET`

The server-side `CALENDAR_STATE_SECRET` and `CALENDAR_TOKEN_ENCRYPTION_KEY` are generated and stored as sensitive Vercel settings. Do not expose them in the browser bundle or commit them to the repository.

Redeploy the Vercel project after setting provider credentials. The user can then sign in to Said and Done, open Settings → Calendar connections, connect each provider, and select “Sync both calendars.” After connecting, Said and Done syncs when the app opens or returns to the foreground and every five minutes while it stays open. Each sync compares edits on both sides and applies the newer change to the linked event and meeting.
