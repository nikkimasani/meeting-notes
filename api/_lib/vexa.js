// Vexa (vexa.ai) meeting-bot adapter. Sign-in works with any Google account.
// Bots are only created by an explicit request from the app.
const BASE = (process.env.VEXA_API_BASE || 'https://api.cloud.vexa.ai').replace(/\/$/, '');

export const vexaConfigured = () => !!process.env.VEXA_API_KEY;

async function vexa(path, init = {}) {
  const res = await fetch(BASE + path, {
    ...init,
    headers: { 'X-API-Key': process.env.VEXA_API_KEY, accept: 'application/json', ...(init.body ? { 'content-type': 'application/json' } : {}), ...(init.headers || {}) },
    signal: AbortSignal.timeout(30000)
  });
  return res;
}
const readJson = async (res) => { const t = await res.text(); try { return JSON.parse(t); } catch { return { raw: t }; } };
const errText = (d) => (typeof d?.detail === 'string' ? d.detail : Array.isArray(d?.detail) ? d.detail.map(x => x.msg || JSON.stringify(x)).join('; ') : d?.error || d?.message || d?.raw || 'Request failed').toString().slice(0, 300);

/** Works out Vexa's platform + native meeting id (+ passcode) from a join link. */
export function parseMeetingUrl(raw) {
  const u = new URL(raw);
  const h = u.hostname;
  if (h === 'meet.google.com') {
    const id = u.pathname.split('/').filter(Boolean)[0];
    if (/^[a-z]{3}-[a-z]{4}-[a-z]{3}$/.test(id || '')) return { platform: 'google_meet', id };
  }
  if (/(^|\.)zoom\.us$/.test(h)) {
    const m = u.pathname.match(/\/(?:j|wc\/join|s)\/(\d{9,12})/);
    if (m) return { platform: 'zoom', id: m[1], passcode: u.searchParams.get('pwd') || undefined };
  }
  if (/(^|\.)teams\.(microsoft|live)\.com$/.test(h)) {
    const meet = u.pathname.match(/\/meet\/(\d{10,15})/);
    if (meet) return { platform: 'teams', id: meet[1], passcode: u.searchParams.get('p') || undefined };
    const decoded = decodeURIComponent(u.pathname);
    const thread = decoded.match(/(19:meeting_[^/@]+@thread\.v2)/);
    if (thread) return { platform: 'teams', id: thread[1] };
  }
  return null;
}

const STATUS_MAP = {
  requested: 'joining_call', joining: 'joining_call', awaiting_admission: 'in_waiting_room', needs_help: 'in_waiting_room',
  active: 'in_call_recording', stopping: 'call_ended', completed: 'done', failed: 'fatal', scheduled: 'scheduled', idle: 'scheduled'
};

export async function vexaCreate({ meetingUrl, joinAt, botName }) {
  const parsed = parseMeetingUrl(meetingUrl);
  if (!parsed) throw Object.assign(new Error('Paste a Teams, Zoom or Google Meet join link.'), { status: 400 });
  const id = `${parsed.platform}/${parsed.id}`;
  const when = joinAt ? new Date(joinAt) : null;
  if (when && when.getTime() - Date.now() > 2 * 60 * 1000) {
    // A one-off plan for this single meeting — Vexa sends the bot ~60 s before the start time.
    const res = await vexa('/meetings', { method: 'POST', body: JSON.stringify({ title: 'Recapp', scheduled_at: when.toISOString(), meeting_url: meetingUrl, auto_join: true }) });
    const data = await readJson(res);
    if (!res.ok) throw Object.assign(new Error(errText(data)), { status: res.status });
    return { id, joinAt: when.toISOString(), scheduled: true };
  }
  const body = {
    platform: parsed.platform,
    native_meeting_id: parsed.id,
    meeting_url: meetingUrl,
    bot_name: botName || 'Recapp Notetaker',
    transcribe_enabled: true,
    recording_enabled: true,
    ...(parsed.passcode ? { passcode: parsed.passcode } : {})
  };
  let res = await vexa('/bots', { method: 'POST', body: JSON.stringify(body) });
  if (res.status === 422) {
    // Older deployments reject meeting_url on this endpoint; retry with the id fields only.
    delete body.meeting_url;
    res = await vexa('/bots', { method: 'POST', body: JSON.stringify(body) });
  }
  const data = await readJson(res);
  if (!res.ok) throw Object.assign(new Error(errText(data)), { status: res.status });
  return { id, joinAt: null, scheduled: false };
}

export async function vexaStatus(id) {
  const [platform, ...rest] = id.split('/');
  const native = rest.join('/');
  const running = await vexa('/bots/status');
  const r = await readJson(running);
  if (running.status === 401 || running.status === 403) throw Object.assign(new Error('Vexa rejected the API key. Check VEXA_API_KEY.'), { status: 401 });
  const list = r.running_bots || r.bots || [];
  const mine = list.find(b => (b.platform === platform) && (b.native_meeting_id === native || b.meeting_id === native));
  const t = await vexa(`/transcripts/${platform}/${encodeURIComponent(native)}`);
  const tr = t.ok ? await readJson(t) : null;
  const rawStatus = mine?.status || mine?.meeting_status || tr?.status || (tr ? 'completed' : 'requested');
  const code = STATUS_MAP[rawStatus] || (mine ? 'in_call_recording' : 'done');
  const segments = Array.isArray(tr?.segments) ? tr.segments : [];
  const done = code === 'done' || code === 'fatal';
  const out = {
    id,
    joinAt: null,
    state: { code, subCode: null, message: mine?.message || tr?.failure_reason || null, at: tr?.end_time || null },
    recorded: segments.length > 0 || ['in_call_recording', 'call_ended', 'done'].includes(code),
    transcript: done
      ? segments
          .filter(s => s.completed !== false && String(s.text || '').trim())
          .map(s => ({ speaker: String(s.speaker || '').trim() || 'Speaker', text: String(s.text).trim(), start: Number(s.start) || 0, end: Number(s.end) || Number(s.start) || 0 }))
      : null,
    transcriptState: done ? 'done' : null,
    audioUrl: null,
    liveLines: segments.length
  };
  if (done && tr?.id) {
    try {
      const recs = await readJson(await vexa(`/recordings?meeting_id=${encodeURIComponent(tr.id)}`));
      const list = recs.recordings || recs.items || (Array.isArray(recs) ? recs : []);
      const rec = list.find(x => String(x.meeting_id) === String(tr.id)) || list[0];
      if (rec?.id) out.audioUrl = `/api/bot?id=${encodeURIComponent(id)}&audio=${encodeURIComponent(rec.id)}`;
    } catch {}
  }
  return out;
}

/** Streams the meeting audio (needs the API key, so it can't go straight to the browser). */
export async function vexaAudio(recordingId) {
  const master = await readJson(await vexa(`/recordings/${encodeURIComponent(recordingId)}/master?type=audio`));
  const url = master.raw_url || master.url;
  if (!url) throw Object.assign(new Error('No audio for this meeting.'), { status: 404 });
  const res = url.startsWith('http') && !url.startsWith(BASE) ? await fetch(url) : await vexa(url.replace(BASE, ''));
  if (!res.ok) throw Object.assign(new Error('Audio download failed.'), { status: res.status });
  return res;
}

export async function vexaStop(id) {
  const [platform, ...rest] = id.split('/');
  const native = rest.join('/');
  const res = await vexa(`/bots/${platform}/${encodeURIComponent(native)}`, { method: 'DELETE' });
  if (!res.ok && res.status !== 404) throw Object.assign(new Error(errText(await readJson(res))), { status: res.status });
  // Also clear a pending plan so a scheduled bot doesn't still join.
  await vexa(`/meetings/${platform}/${encodeURIComponent(native)}/intent`, { method: 'PUT', body: JSON.stringify({ intent: 'idle' }) }).catch(() => {});
  return { ok: true, cancelled: true, left: true };
}
