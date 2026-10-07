import { json, options } from '../_lib/http.js';
import { db, requireUser } from '../_lib/supabase.js';

export async function GET(request) {
  const requestId = crypto.randomUUID();
  try {
    const user = await requireUser(request);
    if (!user) return json(request, { error: 'Sign in is required.', requestId }, 401, requestId);
    const month = new URL(request.url).searchParams.get('month') || new Date().toISOString().slice(0, 7);
    const start = `${month}-01T00:00:00.000Z`;
    const next = new Date(`${month}-01T00:00:00.000Z`); next.setUTCMonth(next.getUTCMonth() + 1);
    const rows = await db(`transcription_usage?user_id=eq.${encodeURIComponent(user.id)}&created_at=gte.${encodeURIComponent(start)}&created_at=lt.${encodeURIComponent(next.toISOString())}&select=duration_seconds,estimated_cost_usd`);
    const totals = (rows || []).reduce((sum, row) => ({ seconds: sum.seconds + Number(row.duration_seconds || 0), estimatedCostUsd: sum.estimatedCostUsd + Number(row.estimated_cost_usd || 0) }), { seconds: 0, estimatedCostUsd: 0 });
    return json(request, { month, minutes: totals.seconds / 60, estimatedCostUsd: totals.estimatedCostUsd, requestId });
  } catch (error) {
    return json(request, { error: error instanceof Error ? error.message : 'Usage could not be loaded.', requestId }, 500, requestId);
  }
}

export const OPTIONS = options;
