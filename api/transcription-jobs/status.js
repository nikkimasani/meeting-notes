import { json, options } from '../_lib/http.js';
import { db, requireUser } from '../_lib/supabase.js';

export async function GET(request) {
  const requestId = request.headers.get('x-client-request-id') || crypto.randomUUID();
  try {
    const user = await requireUser(request);
    if (!user) return json(request, { error: 'Sign in is required.', requestId }, 401, requestId);
    const id = new URL(request.url).searchParams.get('id');
    if (!id) return json(request, { error: 'Job id is required.', requestId }, 400, requestId);
    const rows = await db(`transcription_jobs?id=eq.${encodeURIComponent(id)}&user_id=eq.${encodeURIComponent(user.id)}&select=id,meeting_id,status,total_chunks,completed_chunks,failed_chunks,attempt_count,next_attempt_at,last_error,transcript,segments,duration_seconds,estimated_cost_usd,created_at,started_at,completed_at`);
    if (!rows?.length) return json(request, { error: 'Job not found.', requestId }, 404, requestId);
    const job = rows[0];
    return json(request, { ...job, progress: job.total_chunks ? job.completed_chunks / job.total_chunks : 0, requestId }, 200, requestId);
  } catch (error) {
    return json(request, { error: error instanceof Error ? error.message : 'Job status could not be loaded.', requestId }, 500, requestId);
  }
}

export const OPTIONS = options;
