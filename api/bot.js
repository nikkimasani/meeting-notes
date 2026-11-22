import { json, options } from './_lib/http.js';

// On-demand meeting notetaker via Recall.ai. A bot only joins when the app
// explicitly calls action "create" — there is no calendar auto-join.
//
// Env: RECALL_API_KEY (required), RECALL_REGION (optional; auto-detected).
const REGIONS = ['us-west-2', 'us-east-1', 'eu-central-1', 'ap-northeast-1'];
let detected = { region: process.env.RECALL_REGION || '', auth: '' };

const ALLOWED_HOSTS = [/(^|\.)teams\.microsoft\.com$/, /(^|\.)teams\.live\.com$/, /(^|\.)zoom\.us$/, /^meet\.google\.com$/, /(^|\.)webex\.com$/];

async function recall(path, init = {}) {
  const key = process.env.RECALL_API_KEY;
  if (!key) throw Object.assign(new Error('The meeting bot is not set up yet. Add RECALL_API_KEY in Vercel → Settings → Environment Variables, then redeploy.'), { status: 503 });
  const regions = detected.region ? [detected.region, ...REGIONS.filter(r => r !== detected.region)] : REGIONS;
  const auths = detected.auth ? [detected.auth] : [`Token ${key}`, key];
  let last;
  for (const region of regions) {
    for (const auth of auths) {
      const res = await fetch(`https://${region}.recall.ai/api/v1/${path}`, {
        ...init,
        headers: { Authorization: auth, accept: 'application/json', ...(init.body ? { 'content-type': 'application/json' } : {}), ...(init.headers || {}) },
        signal: AbortSignal.timeout(30000)
      });
      if (res.status === 401 || res.status === 403) { last = res; continue; }
      detected = { region, auth };
      return res;
    }
    // A wrong region answers 401 as well; only keep trying if we never got in.
    if (detected.region) break;
  }
  const detail = last ? await last.text().catch(() => '') : '';
  throw Object.assign(new Error(`Recall.ai rejected the API key${detail ? `: ${detail.slice(0, 160)}` : ''}. Check RECALL_API_KEY.`), { status: 401 });
}

async function body(res) {
  const text = await res.text();
  try { return JSON.parse(text); } catch { return { raw: text }; }
}
const errText = (data) => data?.detail || data?.error || (typeof data === 'object' ? Object.entries(data).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join('; ') : String(data)) || 'Request failed';

function normalizeTranscript(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .map(entry => {
      const words = Array.isArray(entry.words) ? entry.words : [];
      const text = words.map(w => w.text).join(' ').replace(/\s+([,.!?;:])/g, '$1').trim();
      const start = Number(words[0]?.start_timestamp?.relative) || 0;
      const end = Number(words[words.length - 1]?.end_timestamp?.relative) || start;
      return { speaker: String(entry.participant?.name || `Participant ${entry.participant?.id ?? ''}`).trim(), text, start, end };
    })
    .filter(s => s.text);
}

async function status(id) {
  const res = await recall(`bot/${encodeURIComponent(id)}/`);
  const bot = await body(res);
  if (!res.ok) throw Object.assign(new Error(errText(bot)), { status: res.status });
  const changes = Array.isArray(bot.status_changes) ? bot.status_changes : [];
  const latest = changes[changes.length - 1] || null;
  const out = {
    id: bot.id,
    joinAt: bot.join_at || null,
    state: latest ? { code: latest.code, subCode: latest.sub_code || null, message: latest.message || null, at: latest.created_at } : { code: 'scheduled' },
    recorded: changes.some(c => c.code === 'in_call_recording'),
    transcript: null,
    transcriptState: null,
    audioUrl: null
  };
  const rec = Array.isArray(bot.recordings) ? bot.recordings[0] : null;
  if (rec && (out.state.code === 'done' || out.state.code === 'fatal')) {
    const t = rec.media_shortcuts?.transcript;
    out.transcriptState = t?.status?.code || (t ? 'unknown' : 'missing');
    if (t?.data?.download_url && (!t.status || t.status.code === 'done')) {
      const tr = await fetch(t.data.download_url, { signal: AbortSignal.timeout(30000) });
      if (tr.ok) out.transcript = normalizeTranscript(await tr.json().catch(() => null));
    }
    try {
      const a = await recall(`audio_mixed/?recording_id=${encodeURIComponent(rec.id)}`);
      const list = await body(a);
      const item = (list.results || list || []).find?.(x => x?.data?.download_url);
      out.audioUrl = item?.data?.download_url || null;
    } catch {}
    if (!out.audioUrl) out.audioUrl = rec.media_shortcuts?.video_mixed?.data?.download_url || null;
  }
  return out;
}

export async function GET(request) {
  const url = new URL(request.url);
  if (url.searchParams.get('check') === '1') return json(request, { configured: !!process.env.RECALL_API_KEY });
  const id = url.searchParams.get('id');
  if (!id) return json(request, { error: 'Missing bot id.' }, 400);
  try {
    return json(request, await status(id));
  } catch (e) {
    return json(request, { error: e.message }, e.status || 500);
  }
}

export async function POST(request) {
  try {
    const { action, id, meetingUrl, joinAt, botName } = await request.json();
    if (action === 'create') {
      let parsed;
      try { parsed = new URL(String(meetingUrl || '').trim()); } catch { return json(request, { error: 'That doesn’t look like a meeting link.' }, 400); }
      if (parsed.protocol !== 'https:' || !ALLOWED_HOSTS.some(re => re.test(parsed.hostname)))
        return json(request, { error: 'Paste a Microsoft Teams, Zoom, Google Meet or Webex meeting link.' }, 400);
      const when = joinAt ? new Date(joinAt) : null;
      const payload = {
        meeting_url: parsed.toString(),
        bot_name: String(botName || 'Said & Done Notetaker').slice(0, 100),
        recording_config: {
          transcript: { provider: { recallai_streaming: { mode: 'prioritize_accuracy', language_code: 'auto' } } },
          audio_mixed_mp3: {}
        }
      };
      // Recall treats join_at < 10 minutes away as "join now".
      if (when && when.getTime() - Date.now() > 10 * 60 * 1000) payload.join_at = when.toISOString();
      const res = await recall('bot/', { method: 'POST', body: JSON.stringify(payload) });
      const bot = await body(res);
      if (!res.ok) return json(request, { error: errText(bot) }, res.status);
      return json(request, { id: bot.id, joinAt: bot.join_at || null, scheduled: !!payload.join_at });
    }
    if (!id) return json(request, { error: 'Missing bot id.' }, 400);
    if (action === 'leave' || action === 'cancel') {
      if (action === 'cancel') {
        const del = await recall(`bot/${encodeURIComponent(id)}/`, { method: 'DELETE' });
        if (del.ok || del.status === 204) return json(request, { ok: true, cancelled: true });
      }
      const res = await recall(`bot/${encodeURIComponent(id)}/leave_call/`, { method: 'POST' });
      if (!res.ok) return json(request, { error: errText(await body(res)) }, res.status);
      return json(request, { ok: true, left: true });
    }
    return json(request, { error: 'Unknown action.' }, 400);
  } catch (e) {
    return json(request, { error: e.message || 'Bot request failed.' }, e.status || 500);
  }
}
export const OPTIONS = options;
