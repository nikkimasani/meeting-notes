function config() {
  const url = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const anonKey = process.env.SUPABASE_ANON_KEY;
  if (!url || !serviceKey || !anonKey) throw new Error('Supabase background processing is not configured.');
  return { url: url.replace(/\/$/, ''), serviceKey, anonKey };
}

export async function requireUser(request) {
  const { url, anonKey } = config();
  const authorization = request.headers.get('authorization') || '';
  if (!authorization.startsWith('Bearer ')) return null;
  const response = await fetch(`${url}/auth/v1/user`, {
    headers: { authorization, apikey: anonKey },
    signal: AbortSignal.timeout(10000)
  });
  return response.ok ? response.json() : null;
}

export async function db(path, init = {}) {
  const { url, serviceKey } = config();
  const response = await fetch(`${url}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: serviceKey,
      authorization: `Bearer ${serviceKey}`,
      'content-type': 'application/json',
      ...(init.headers || {})
    },
    signal: init.signal || AbortSignal.timeout(20000)
  });
  const raw = await response.text();
  let data = null;
  if (raw) {
    try { data = JSON.parse(raw); } catch { data = raw; }
  }
  if (!response.ok) throw new Error(typeof data === 'object' && data?.message ? data.message : `Supabase request failed (${response.status}).`);
  return data;
}

export async function downloadObject(path) {
  const { url, serviceKey } = config();
  const safePath = path.split('/').map(encodeURIComponent).join('/');
  const response = await fetch(`${url}/storage/v1/object/authenticated/meeting-transcription-chunks/${safePath}`, {
    headers: { apikey: serviceKey, authorization: `Bearer ${serviceKey}` },
    signal: AbortSignal.timeout(30000)
  });
  if (!response.ok) throw new Error(`Audio chunk could not be downloaded (${response.status}).`);
  return response.blob();
}
