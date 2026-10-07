-- Durable, resumable transcription jobs. Run in the Supabase SQL editor once.
create extension if not exists pgcrypto;

create table if not exists public.transcription_jobs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  meeting_id text not null,
  idempotency_key text not null,
  language text not null default 'auto',
  status text not null default 'queued' check (status in ('queued','processing','retrying','complete','partial','failed','canceled')),
  total_chunks integer not null default 0,
  completed_chunks integer not null default 0,
  failed_chunks integer not null default 0,
  attempt_count integer not null default 0,
  next_attempt_at timestamptz,
  last_error text,
  transcript text,
  -- Array of {sequence, durationSeconds, segments}; clients offset each chunk by preceding durations.
  segments jsonb not null default '[]'::jsonb,
  duration_seconds numeric not null default 0,
  estimated_cost_usd numeric(12,6) not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz,
  unique (user_id, idempotency_key)
);

create table if not exists public.transcription_chunks (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.transcription_jobs(id) on delete cascade,
  sequence integer not null,
  storage_path text not null,
  sha256 text,
  bytes bigint not null default 0,
  duration_seconds numeric not null default 0,
  status text not null default 'pending' check (status in ('pending','processing','retrying','complete','failed')),
  attempt_count integer not null default 0,
  next_attempt_at timestamptz,
  lease_expires_at timestamptz,
  transcript text,
  segments jsonb not null default '[]'::jsonb,
  model text,
  estimated_cost_usd numeric(12,6) not null default 0,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz,
  unique (job_id, sequence),
  unique (job_id, sha256)
);

create table if not exists public.transcription_usage (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  job_id uuid not null references public.transcription_jobs(id) on delete cascade,
  chunk_id uuid not null references public.transcription_chunks(id) on delete cascade,
  model text not null,
  duration_seconds numeric not null default 0,
  estimated_cost_usd numeric(12,6) not null default 0,
  created_at timestamptz not null default now(),
  unique (chunk_id)
);

create index if not exists transcription_chunks_claim_idx on public.transcription_chunks (status, next_attempt_at, lease_expires_at, created_at);
create index if not exists transcription_jobs_user_created_idx on public.transcription_jobs (user_id, created_at desc);
create index if not exists transcription_usage_user_created_idx on public.transcription_usage (user_id, created_at desc);

alter table public.transcription_jobs enable row level security;
alter table public.transcription_chunks enable row level security;
alter table public.transcription_usage enable row level security;
create policy "read own transcription jobs" on public.transcription_jobs for select to authenticated using (auth.uid() = user_id);
create policy "read own transcription chunks" on public.transcription_chunks for select to authenticated using (exists (select 1 from public.transcription_jobs j where j.id = job_id and j.user_id = auth.uid()));
create policy "read own transcription usage" on public.transcription_usage for select to authenticated using (auth.uid() = user_id);

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('meeting-transcription-chunks', 'meeting-transcription-chunks', false, 25165824, array['audio/wav','audio/webm','audio/mp4','audio/mpeg'])
on conflict (id) do update set public = excluded.public, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;
create policy "upload own transcription chunks" on storage.objects for insert to authenticated
with check (bucket_id = 'meeting-transcription-chunks' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "update own transcription chunks" on storage.objects for update to authenticated
using (bucket_id = 'meeting-transcription-chunks' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "read own transcription chunks storage" on storage.objects for select to authenticated
using (bucket_id = 'meeting-transcription-chunks' and (storage.foldername(name))[1] = auth.uid()::text);

create or replace function public.create_transcription_job(p_user_id uuid, p_meeting_id text, p_language text, p_idempotency_key text, p_chunks jsonb)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_job_id uuid; v_chunk jsonb;
begin
  insert into transcription_jobs(user_id, meeting_id, language, idempotency_key, total_chunks)
  values (p_user_id, p_meeting_id, coalesce(nullif(p_language,''),'auto'), p_idempotency_key, jsonb_array_length(p_chunks))
  on conflict (user_id, idempotency_key) do update set updated_at = now()
  returning id into v_job_id;
  if not exists (select 1 from transcription_chunks where job_id = v_job_id) then
    for v_chunk in select * from jsonb_array_elements(p_chunks) loop
      insert into transcription_chunks(job_id, sequence, storage_path, duration_seconds, bytes, sha256)
      values (v_job_id, (v_chunk->>'sequence')::integer, v_chunk->>'storage_path', coalesce((v_chunk->>'duration_seconds')::numeric,0), coalesce((v_chunk->>'bytes')::bigint,0), nullif(v_chunk->>'sha256',''));
    end loop;
  end if;
  return v_job_id;
end $$;

create or replace function public.claim_transcription_chunk()
returns table(chunk_id uuid, job_id uuid, sequence integer, storage_path text, duration_seconds numeric, attempt_count integer, language text)
language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  select c.id into v_id from transcription_chunks c join transcription_jobs j on j.id = c.job_id
  where j.status not in ('complete','failed','canceled') and
    ((c.status in ('pending','retrying') and (c.next_attempt_at is null or c.next_attempt_at <= now())) or
     (c.status = 'processing' and c.lease_expires_at < now()))
  order by c.created_at, c.sequence for update skip locked limit 1;
  if v_id is null then return; end if;
  update transcription_chunks c set status='processing', attempt_count=c.attempt_count+1, lease_expires_at=now()+interval '3 minutes', updated_at=now()
  where c.id=v_id;
  update transcription_jobs j set status='processing', started_at=coalesce(j.started_at,now()), attempt_count=j.attempt_count+1, updated_at=now()
  where j.id=(select c.job_id from transcription_chunks c where c.id=v_id);
  return query select c.id,c.job_id,c.sequence,c.storage_path,c.duration_seconds,c.attempt_count,j.language from transcription_chunks c join transcription_jobs j on j.id=c.job_id where c.id=v_id;
end $$;

create or replace function public.complete_transcription_chunk(p_chunk_id uuid, p_transcript text, p_segments jsonb, p_duration_seconds numeric, p_model text, p_estimated_cost_usd numeric)
returns void language plpgsql security definer set search_path = public as $$
declare v_job_id uuid; v_user_id uuid;
begin
  update transcription_chunks set status='complete', transcript=p_transcript, segments=coalesce(p_segments,'[]'::jsonb), duration_seconds=greatest(coalesce(p_duration_seconds,0),duration_seconds), model=p_model, estimated_cost_usd=coalesce(p_estimated_cost_usd,0), last_error=null, lease_expires_at=null, completed_at=now(), updated_at=now()
  where id=p_chunk_id returning job_id into v_job_id;
  select user_id into v_user_id from transcription_jobs where id=v_job_id;
  insert into transcription_usage(user_id,job_id,chunk_id,model,duration_seconds,estimated_cost_usd)
  select v_user_id,v_job_id,id,p_model,duration_seconds,estimated_cost_usd from transcription_chunks where id=p_chunk_id on conflict(chunk_id) do nothing;
  update transcription_jobs j set
    completed_chunks=(select count(*) from transcription_chunks where job_id=v_job_id and status='complete'),
    failed_chunks=(select count(*) from transcription_chunks where job_id=v_job_id and status='failed'),
    transcript=(select string_agg(transcript,E'\n\n' order by sequence) from transcription_chunks where job_id=v_job_id and status='complete'),
    segments=(select coalesce(jsonb_agg(jsonb_build_object('sequence',sequence,'durationSeconds',duration_seconds,'segments',segments) order by sequence),'[]'::jsonb) from transcription_chunks where job_id=v_job_id and status='complete'),
    duration_seconds=(select coalesce(sum(duration_seconds),0) from transcription_chunks where job_id=v_job_id and status='complete'),
    estimated_cost_usd=(select coalesce(sum(estimated_cost_usd),0) from transcription_chunks where job_id=v_job_id and status='complete'), updated_at=now()
  where j.id=v_job_id;
  update transcription_jobs set status='complete', completed_at=now() where id=v_job_id and completed_chunks=total_chunks;
end $$;

create or replace function public.fail_transcription_chunk(p_chunk_id uuid, p_error text, p_terminal boolean)
returns void language plpgsql security definer set search_path = public as $$
declare v_job_id uuid; v_attempt integer;
begin
  select job_id,attempt_count into v_job_id,v_attempt from transcription_chunks where id=p_chunk_id;
  update transcription_chunks set status=case when p_terminal then 'failed' else 'retrying' end, last_error=p_error,
    next_attempt_at=case when p_terminal then null else now()+make_interval(secs => least(300, power(2,greatest(v_attempt,1))::integer*5)) end,
    lease_expires_at=null, updated_at=now() where id=p_chunk_id;
  update transcription_jobs j set failed_chunks=(select count(*) from transcription_chunks where job_id=v_job_id and status='failed'),
    status=case when p_terminal then case when exists(select 1 from transcription_chunks where job_id=v_job_id and status='complete') then 'partial' else 'failed' end else 'retrying' end,
    next_attempt_at=case when p_terminal then null else (select min(next_attempt_at) from transcription_chunks where job_id=v_job_id and status='retrying') end,
    last_error=p_error, completed_at=case when p_terminal then now() else null end, updated_at=now() where j.id=v_job_id;
end $$;

revoke all on function public.create_transcription_job(uuid,text,text,text,jsonb) from public, anon, authenticated;
revoke all on function public.claim_transcription_chunk() from public, anon, authenticated;
revoke all on function public.complete_transcription_chunk(uuid,text,jsonb,numeric,text,numeric) from public, anon, authenticated;
revoke all on function public.fail_transcription_chunk(uuid,text,boolean) from public, anon, authenticated;
grant execute on function public.create_transcription_job(uuid,text,text,text,jsonb) to service_role;
grant execute on function public.claim_transcription_chunk() to service_role;
grant execute on function public.complete_transcription_chunk(uuid,text,jsonb,numeric,text,numeric) to service_role;
grant execute on function public.fail_transcription_chunk(uuid,text,boolean) to service_role;
