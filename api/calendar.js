export const config = { runtime: "edge" };

const SB_URL = "https://bazjlrualnmbanmhiuau.supabase.co";
const SB_KEY = "sb_publishable_ez3TVctnbFIUHqr_dMOUeQ_5WpsYEHs";
const ALLOWED_ORIGINS = new Set([
  "https://meeting-notes-nikkimasanis-projects.vercel.app",
  "https://meeting-notes-git-main-nikkimasanis-projects.vercel.app",
  "https://meeting-notes-eta-ecru.vercel.app",
  "https://meeting-notes-cloudflare.pages.dev"
]);
const encoder = new TextEncoder();

export default async function handler(request) {
  if (request.method !== "POST") return json({ error: "Method not allowed." }, 405);
  try {
    const body = await request.json();
    const action = body && body.action;
    if (!["start", "complete", "status", "disconnect", "sync"].includes(action)) {
      return json({ error: "Unknown calendar action." }, 400);
    }
    const accessToken = bearer(request);
    const user = await authenticate(accessToken);
    if (!user) return json({ error: "Sign in to Said and Done before connecting a calendar." }, 401);

    if (action === "start") return await startAuthorization(request, user, body.provider);
    if (action === "complete") return await completeAuthorization(request, user, body);
    if (action === "status") return await calendarStatus(accessToken);
    if (action === "disconnect") return await disconnectCalendar(accessToken, body.provider);
    return await syncCalendars(accessToken, user, body.meetings);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Calendar sync failed.";
    const status = message.startsWith("CONFIG:") ? 503 : 400;
    return json({ error: message.replace(/^CONFIG:/, "").trim() }, status);
  }
}

function json(body, status) {
  return new Response(JSON.stringify(body), {
    status: status || 200,
    headers: { "content-type": "application/json", "cache-control": "no-store" }
  });
}
function bearer(request) {
  const value = request.headers.get("authorization") || "";
  return value.replace(/^Bearer\s+/i, "");
}
async function authenticate(token) {
  if (!token) return null;
  const response = await fetch(SB_URL + "/auth/v1/user", {
    headers: { apikey: SB_KEY, authorization: "Bearer " + token }
  });
  if (!response.ok) return null;
  const user = await response.json();
  return user && user.id ? user : null;
}
function providerName(value) {
  return value === "google" || value === "microsoft" ? value : null;
}
function origins() {
  return ALLOWED_ORIGINS;
}
function assertOrigin(origin) {
  if (!origin || !origins().has(origin)) throw new Error("This Said and Done app address is not configured for calendar connections.");
}
function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error("CONFIG:Calendar sync needs the Vercel setting " + name + ".");
  return value;
}
function clientConfig(provider) {
  if (provider === "google") {
    return {
      clientId: requireEnv("GOOGLE_CALENDAR_CLIENT_ID"),
      clientSecret: requireEnv("GOOGLE_CALENDAR_CLIENT_SECRET")
    };
  }
  return {
    clientId: requireEnv("MICROSOFT_CALENDAR_CLIENT_ID"),
    clientSecret: requireEnv("MICROSOFT_CALENDAR_CLIENT_SECRET")
  };
}
function b64url(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
function fromB64url(value) {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((value.length + 3) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, character => character.charCodeAt(0));
}
async function stateKey() {
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(requireEnv("CALENDAR_STATE_SECRET")),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  );
}
async function signedState(payload) {
  const encoded = b64url(encoder.encode(JSON.stringify(payload)));
  const signature = await crypto.subtle.sign("HMAC", await stateKey(), encoder.encode(encoded));
  return encoded + "." + b64url(new Uint8Array(signature));
}
async function readState(value) {
  if (typeof value !== "string" || value.length > 3000) throw new Error("Calendar sign-in state is invalid.");
  const pieces = value.split(".");
  if (pieces.length !== 2) throw new Error("Calendar sign-in state is invalid.");
  const valid = await crypto.subtle.verify(
    "HMAC",
    await stateKey(),
    fromB64url(pieces[1]),
    encoder.encode(pieces[0])
  );
  if (!valid) throw new Error("Calendar sign-in state could not be verified.");
  const payload = JSON.parse(new TextDecoder().decode(fromB64url(pieces[0])));
  if (!payload || Date.now() > payload.expiresAt || Date.now() < payload.issuedAt - 60000) {
    throw new Error("Calendar sign-in state expired. Start the connection again.");
  }
  if (!providerName(payload.provider) || !ALLOWED_ORIGINS.has(payload.origin)) {
    throw new Error("Calendar sign-in state is invalid.");
  }
  return payload;
}
function redirectUri(origin) {
  return origin + "/";
}
async function startAuthorization(request, user, rawProvider) {
  const provider = providerName(rawProvider);
  if (!provider) return json({ error: "Choose Google Calendar or Outlook." }, 400);
  const origin = request.headers.get("origin");
  assertOrigin(origin);
  const client = clientConfig(provider);
  const state = await signedState({
    provider,
    userId: user.id,
    origin,
    issuedAt: Date.now(),
    expiresAt: Date.now() + 10 * 60 * 1000,
    nonce: crypto.randomUUID()
  });
  const redirect = redirectUri(origin);
  const url = new URL(provider === "google"
    ? "https://accounts.google.com/o/oauth2/v2/auth"
    : "https://login.microsoftonline.com/common/oauth2/v2.0/authorize");
  url.searchParams.set("client_id", client.clientId);
  url.searchParams.set("redirect_uri", redirect);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("state", state);
  if (provider === "google") {
    url.searchParams.set("scope", "openid email https://www.googleapis.com/auth/calendar.events");
    url.searchParams.set("access_type", "offline");
    url.searchParams.set("prompt", "consent");
    url.searchParams.set("include_granted_scopes", "true");
  } else {
    url.searchParams.set("scope", "openid profile email offline_access User.Read Calendars.ReadWrite");
    url.searchParams.set("response_mode", "query");
    url.searchParams.set("prompt", "select_account");
  }
  return json({ authorizationUrl: url.toString() });
}
async function completeAuthorization(request, user, body) {
  const state = await readState(body.state);
  if (state.userId !== user.id) throw new Error("Sign in with the same Said and Done account used to start calendar connection.");
  if (request.headers.get("origin") !== state.origin) throw new Error("The calendar sign-in returned to a different app address.");
  const provider = state.provider;
  const client = clientConfig(provider);
  const redirect = redirectUri(state.origin);
  const form = new URLSearchParams();
  form.set("client_id", client.clientId);
  form.set("client_secret", client.clientSecret);
  form.set("code", String(body.code || ""));
  form.set("redirect_uri", redirect);
  form.set("grant_type", "authorization_code");
  if (provider === "microsoft") form.set("scope", "openid profile email offline_access User.Read Calendars.ReadWrite");
  const tokenUrl = provider === "google"
    ? "https://oauth2.googleapis.com/token"
    : "https://login.microsoftonline.com/common/oauth2/v2.0/token";
  const response = await fetch(tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form.toString()
  });
  const tokens = await response.json();
  if (!response.ok || !tokens.access_token) {
    throw new Error("Calendar authorization failed. Check the provider app registration and redirect URI.");
  }
  let email = "";
  try {
    const profileUrl = provider === "google"
      ? "https://www.googleapis.com/oauth2/v2/userinfo"
      : "https://graph.microsoft.com/v1.0/me?$select=mail,userPrincipalName";
    const profileResponse = await fetch(profileUrl, {
      headers: { authorization: "Bearer " + tokens.access_token }
    });
    if (profileResponse.ok) {
      const profile = await profileResponse.json();
      email = provider === "google" ? (profile.email || "") : (profile.mail || profile.userPrincipalName || "");
    }
  } catch {}
  const existing = await rest(
    "mn_calendar_connections?select=refresh_token_ciphertext,refresh_token_iv&provider=eq." +
      provider + "&limit=1",
    accessTokenForRequest(request),
    "GET"
  );
  let refreshToken = tokens.refresh_token;
  if (!refreshToken && existing && existing[0]) {
    refreshToken = await decrypt(existing[0].refresh_token_ciphertext, existing[0].refresh_token_iv);
  }
  if (!refreshToken) throw new Error("The provider did not return a refresh token. Disconnect it in provider settings, then connect again.");
  const encrypted = await encrypt(refreshToken);
  const connection = {
    user_id: user.id,
    provider,
    refresh_token_ciphertext: encrypted.ciphertext,
    refresh_token_iv: encrypted.iv,
    account_email: email,
    calendar_id: "primary",
    scopes: (tokens.scope || "").split(" ").filter(Boolean),
    updated_at: new Date().toISOString()
  };
  await rest("mn_calendar_connections?on_conflict=user_id,provider", accessTokenForRequest(request), "POST", [connection], "resolution=merge-duplicates,return=minimal");
  return json({ connected: true, provider, accountEmail: email });
}
function accessTokenForRequest(request) {
  return bearer(request);
}
async function calendarStatus(token) {
  const rows = await rest(
    "mn_calendar_connections?select=provider,account_email,calendar_id,updated_at",
    token,
    "GET"
  );
  return json({ connections: rows || [] });
}
async function disconnectCalendar(token, rawProvider) {
  const provider = providerName(rawProvider);
  if (!provider) return json({ error: "Choose a calendar provider." }, 400);
  await rest("mn_calendar_connections?provider=eq." + provider, token, "DELETE");
  return json({ disconnected: true, provider });
}
async function rest(path, token, method, body, prefer) {
  const headers = { apikey: SB_KEY, authorization: "Bearer " + token };
  if (body !== undefined) headers["content-type"] = "application/json";
  if (prefer) headers.Prefer = prefer;
  const response = await fetch(SB_URL + "/rest/v1/" + path, {
    method: method || "GET",
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await response.text();
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) throw new Error("Calendar storage denied access. Sign in again or check the calendar tables' RLS policies.");
    throw new Error("Calendar storage request failed (" + response.status + ").");
  }
  if (!text) return null;
  try { return JSON.parse(text); } catch { return null; }
}
async function encrypt(value) {
  const key = await encryptionKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, encoder.encode(value));
  return { ciphertext: b64url(new Uint8Array(cipher)), iv: b64url(iv) };
}
async function decrypt(ciphertext, iv) {
  const key = await encryptionKey();
  const raw = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: fromB64url(iv) },
    key,
    fromB64url(ciphertext)
  );
  return new TextDecoder().decode(raw);
}
async function encryptionKey() {
  const raw = fromB64url(requireEnv("CALENDAR_TOKEN_ENCRYPTION_KEY"));
  if (raw.length !== 32) throw new Error("CONFIG:CALENDAR_TOKEN_ENCRYPTION_KEY must be a base64-encoded 32-byte key.");
  return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}
async function refreshAccessToken(provider, refreshToken) {
  const client = clientConfig(provider);
  const form = new URLSearchParams();
  form.set("client_id", client.clientId);
  form.set("client_secret", client.clientSecret);
  form.set("refresh_token", refreshToken);
  form.set("grant_type", "refresh_token");
  if (provider === "microsoft") form.set("scope", "openid profile email offline_access User.Read Calendars.ReadWrite");
  const tokenUrl = provider === "google"
    ? "https://oauth2.googleapis.com/token"
    : "https://login.microsoftonline.com/common/oauth2/v2.0/token";
  const response = await fetch(tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form.toString()
  });
  const tokens = await response.json();
  if (!response.ok || !tokens.access_token) throw new Error(provider + " authorization expired. Reconnect the calendar in Settings.");
  return tokens;
}
function iso(value) {
  if (!value) return null;
  const raw = String(value);
  const parsed = new Date(raw);
  if (!Number.isFinite(parsed.getTime())) return null;
  return parsed.toISOString();
}
function durationFor(meeting) {
  const seconds = Number(meeting.duration) || 0;
  return Math.min(24 * 60 * 60, Math.max(30 * 60, seconds));
}
function descriptionFor(meeting) {
  return [
    "Meeting type: " + (meeting.meetingType || "general"),
    "Attendees: " + (meeting.attendees || ""),
    "",
    "Agenda:",
    meeting.agenda || "",
    "",
    "Notes:",
    meeting.notes || "",
    "",
    "Managed by Said and Done"
  ].join("\n");
}
function appSnapshot(meeting) {
  const start = iso(meeting.date);
  if (!start) throw new Error("A planned meeting has an invalid date.");
  const end = new Date(Date.parse(start) + durationFor(meeting) * 1000).toISOString();
  return { title: String(meeting.title || "Untitled meeting"), start, end, description: descriptionFor(meeting) };
}
function timedIso(value) {
  if (!value) return null;
  const normalized = /(?:Z|[+-]\d\d:\d\d)$/i.test(value) ? value : value + "Z";
  return iso(normalized);
}
function remoteSnapshot(provider, event) {
  if (!event || event.status === "cancelled" || event.isCancelled) return null;
  const startValue = provider === "google" ? event.start && event.start.dateTime : event.start && event.start.dateTime;
  const endValue = provider === "google" ? event.end && event.end.dateTime : event.end && event.end.dateTime;
  const start = timedIso(startValue);
  const end = timedIso(endValue);
  if (!start || !end) return null;
  return {
    title: String(provider === "google" ? event.summary || "" : event.subject || ""),
    start,
    end,
    description: String(provider === "google" ? event.description || "" : event.body && event.body.content || "")
  };
}
function eventUpdatedAt(provider, event) {
  return iso(provider === "google" ? event.updated : event.lastModifiedDateTime) || new Date().toISOString();
}
function toGoogleEvent(snapshot, meeting) {
  return {
    summary: snapshot.title,
    description: snapshot.description,
    start: { dateTime: snapshot.start },
    end: { dateTime: snapshot.end },
    extendedProperties: { private: { saidDoneMeetingId: meeting.id } }
  };
}
function toMicrosoftEvent(snapshot, meeting) {
  return {
    subject: snapshot.title,
    body: { contentType: "text", content: snapshot.description },
    start: { dateTime: snapshot.start.replace(/Z$/, ""), timeZone: "UTC" },
    end: { dateTime: snapshot.end.replace(/Z$/, ""), timeZone: "UTC" },
    transactionId: meeting.id
  };
}
async function providerRequest(provider, accessToken, url, method, body) {
  const headers = { authorization: "Bearer " + accessToken };
  if (body !== undefined) headers["content-type"] = "application/json";
  if (provider === "microsoft") headers.Prefer = 'outlook.timezone="UTC", outlook.body-content-type="text"';
  const response = await fetch(url, {
    method: method || "GET",
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await response.text();
  let result = null;
  try { result = text ? JSON.parse(text) : null; } catch {}
  if (!response.ok) {
    if (response.status === 404) return { missing: true };
    if (response.status === 401 || response.status === 403) throw new Error(provider + " denied calendar access. Reconnect it in Settings.");
    throw new Error(provider + " calendar request failed (" + response.status + ").");
  }
  return { data: result };
}
async function getProviderEvent(provider, token, id) {
  const url = provider === "google"
    ? "https://www.googleapis.com/calendar/v3/calendars/primary/events/" + encodeURIComponent(id)
    : "https://graph.microsoft.com/v1.0/me/events/" + encodeURIComponent(id) + "?$select=id,subject,start,end,body,lastModifiedDateTime,isCancelled,transactionId";
  return providerRequest(provider, token, url, "GET");
}
async function createProviderEvent(provider, token, meeting, snapshot) {
  const url = provider === "google"
    ? "https://www.googleapis.com/calendar/v3/calendars/primary/events"
    : "https://graph.microsoft.com/v1.0/me/events";
  return providerRequest(provider, token, url, "POST", provider === "google" ? toGoogleEvent(snapshot, meeting) : toMicrosoftEvent(snapshot, meeting));
}
async function updateProviderEvent(provider, token, eventId, snapshot, meeting) {
  const url = provider === "google"
    ? "https://www.googleapis.com/calendar/v3/calendars/primary/events/" + encodeURIComponent(eventId)
    : "https://graph.microsoft.com/v1.0/me/events/" + encodeURIComponent(eventId);
  const patch = provider === "google"
    ? toGoogleEvent(snapshot, meeting)
    : { subject: snapshot.title, body: { contentType: "text", content: snapshot.description }, start: { dateTime: snapshot.start.replace(/Z$/, ""), timeZone: "UTC" }, end: { dateTime: snapshot.end.replace(/Z$/, ""), timeZone: "UTC" } };
  return providerRequest(provider, token, url, "PATCH", patch);
}
function parseDescription(text, existing) {
  const value = String(text || "");
  if (!value.includes("Agenda:") && !value.includes("Notes:")) {
    return { ...existing, agenda: "", notes: value.replace(/\n?Managed by Said and Done\s*$/, "") };
  }
  const read = (label, nextLabel) => {
    const begin = value.indexOf(label + "\n");
    if (begin < 0) return "";
    const start = begin + label.length + 1;
    const end = nextLabel ? value.indexOf("\n\n" + nextLabel + "\n", start) : -1;
    return value.slice(start, end < 0 ? undefined : end).replace(/\n?Managed by Said and Done\s*$/, "");
  };
  const type = value.match(/^Meeting type:\s*(.*)$/m);
  const attendees = value.match(/^Attendees:\s*(.*)$/m);
  return {
    meetingType: type ? type[1].trim() : existing.meetingType,
    attendees: attendees ? attendees[1].trim() : existing.attendees,
    agenda: read("Agenda:", "Notes:"),
    notes: read("Notes:", null)
  };
}
function applyRemote(meeting, snapshot, updatedAt) {
  const details = parseDescription(snapshot.description, meeting);
  const duration = Math.max(0, Math.round((Date.parse(snapshot.end) - Date.parse(snapshot.start)) / 1000));
  return {
    ...meeting,
    title: snapshot.title || meeting.title,
    date: snapshot.start,
    duration,
    ...details,
    updatedAt
  };
}
function sameSnapshot(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}
async function syncCalendars(token, user, incoming) {
  if (!Array.isArray(incoming) || incoming.length > 300) return json({ error: "Sync up to 300 planned meetings at a time." }, 400);
  const meetings = incoming.filter(item => item && item.status === "planned" && /^[0-9a-f-]{36}$/i.test(item.id));
  const rows = await rest("mn_calendar_connections?select=provider,refresh_token_ciphertext,refresh_token_iv,account_email,calendar_id,scopes", token, "GET");
  const results = [];
  const changes = new Map(meetings.map(meeting => [meeting.id, meeting]));
  for (const connection of rows || []) {
    const provider = providerName(connection.provider);
    if (!provider) continue;
    try {
      let refreshToken = await decrypt(connection.refresh_token_ciphertext, connection.refresh_token_iv);
      const access = await refreshAccessToken(provider, refreshToken);
      if (access.refresh_token) {
        refreshToken = access.refresh_token;
        const encrypted = await encrypt(refreshToken);
        await rest("mn_calendar_connections?on_conflict=user_id,provider", token, "POST", [{
          user_id: user.id,
          provider,
          refresh_token_ciphertext: encrypted.ciphertext,
          refresh_token_iv: encrypted.iv,
          account_email: connection.account_email || "",
          calendar_id: connection.calendar_id || "primary",
          scopes: connection.scopes || [],
          updated_at: new Date().toISOString()
        }], "resolution=merge-duplicates,return=minimal");
      }
      const accessToken = access.access_token;
      const linkRows = await rest("mn_calendar_event_links?select=meeting_id,provider_event_id,app_snapshot,provider_snapshot,provider_updated_at&provider=eq." + provider, token, "GET");
      const links = new Map((linkRows || []).map(link => [link.meeting_id, link]));
      const toSave = [];
      let created = 0, updatedFromCalendar = 0, updatedCalendar = 0, unchanged = 0;
      const conflicts = [];
      for (const original of meetings) {
        let meeting = changes.get(original.id) || original;
        let appNow;
        try { appNow = appSnapshot(meeting); } catch (error) { conflicts.push({ meetingId: meeting.id, message: error.message }); continue; }
        const link = links.get(meeting.id);
        let remoteEvent, remoteNow, providerUpdated;
        if (link) {
          const fetched = await getProviderEvent(provider, accessToken, link.provider_event_id);
          if (fetched.missing || !fetched.data || fetched.data.status === "cancelled" || fetched.data.isCancelled) {
            conflicts.push({ meetingId: meeting.id, message: "The linked " + provider + " event was deleted or cancelled. Said and Done kept its meeting and did not recreate the calendar event." });
            continue;
          }
          remoteEvent = fetched.data;
          remoteNow = remoteSnapshot(provider, remoteEvent);
          if (!remoteNow) {
            conflicts.push({ meetingId: meeting.id, message: "The linked " + provider + " event is an all-day event and was not changed." });
            continue;
          }
          providerUpdated = eventUpdatedAt(provider, remoteEvent);
          const appChanged = !sameSnapshot(appNow, link.app_snapshot);
          const providerChanged = !sameSnapshot(remoteNow, link.provider_snapshot);
          if (appChanged && providerChanged) {
            const localAt = Date.parse(meeting.updatedAt || "1970-01-01T00:00:00Z");
            const remoteAt = Date.parse(providerUpdated || "1970-01-01T00:00:00Z");
            if (remoteAt > localAt) {
              meeting = applyRemote(meeting, remoteNow, providerUpdated);
              changes.set(meeting.id, meeting);
              appNow = appSnapshot(meeting);
              updatedFromCalendar++;
            } else {
              const updated = await updateProviderEvent(provider, accessToken, link.provider_event_id, appNow, meeting);
              remoteEvent = updated.data || remoteEvent;
              remoteNow = appNow;
              providerUpdated = eventUpdatedAt(provider, remoteEvent);
              updatedCalendar++;
            }
          } else if (providerChanged) {
            meeting = applyRemote(meeting, remoteNow, providerUpdated);
            changes.set(meeting.id, meeting);
            appNow = appSnapshot(meeting);
            updatedFromCalendar++;
          } else if (appChanged) {
            const updated = await updateProviderEvent(provider, accessToken, link.provider_event_id, appNow, meeting);
            remoteEvent = updated.data || remoteEvent;
            remoteNow = appNow;
            providerUpdated = eventUpdatedAt(provider, remoteEvent);
            updatedCalendar++;
          } else unchanged++;
        } else {
          const createdEvent = await createProviderEvent(provider, accessToken, meeting, appNow);
          if (!createdEvent.data || !createdEvent.data.id) throw new Error(provider + " did not return a calendar event ID.");
          remoteEvent = createdEvent.data;
          remoteNow = remoteSnapshot(provider, remoteEvent) || appNow;
          providerUpdated = eventUpdatedAt(provider, remoteEvent);
          created++;
        }
        toSave.push({
          user_id: user.id,
          provider,
          meeting_id: meeting.id,
          provider_event_id: link ? link.provider_event_id : remoteEvent.id,
          app_snapshot: appNow,
          provider_snapshot: remoteNow,
          provider_updated_at: providerUpdated,
          synced_at: new Date().toISOString()
        });
      }
      if (toSave.length) await rest("mn_calendar_event_links?on_conflict=user_id,provider,meeting_id", token, "POST", toSave, "resolution=merge-duplicates,return=minimal");
      results.push({ provider, connected: true, created, updatedFromCalendar, updatedCalendar, unchanged, conflicts });
    } catch (error) {
      results.push({ provider, connected: true, error: error instanceof Error ? error.message : "Calendar sync failed." });
    }
  }
  const updates = [...changes.values()].filter(meeting => meetings.some(item => item.id === meeting.id));
  return json({ results, meetings: updates });
}