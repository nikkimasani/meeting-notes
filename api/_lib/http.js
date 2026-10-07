const ALLOWED_ORIGINS = new Set([
  'https://meeting-notes-cloudflare.pages.dev',
  'https://meeting-notes-eta-ecru.vercel.app'
]);

export function corsHeaders(request) {
  const origin = request?.headers?.get('origin') || '';
  return {
    'access-control-allow-origin': ALLOWED_ORIGINS.has(origin) ? origin : 'https://meeting-notes-cloudflare.pages.dev',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'authorization, content-type, idempotency-key, x-client-request-id',
    'access-control-expose-headers': 'x-request-id',
    vary: 'Origin'
  };
}

export function json(request, body, status = 200, requestId = '') {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders(request),
      'content-type': 'application/json',
      'cache-control': 'no-store',
      ...(requestId ? { 'x-request-id': requestId } : {})
    }
  });
}

export function options(request) {
  return new Response(null, { status: 204, headers: corsHeaders(request) });
}
