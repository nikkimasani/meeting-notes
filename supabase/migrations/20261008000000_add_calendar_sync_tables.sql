create table if not exists public.mn_calendar_connections (
  user_id uuid not null references auth.users(id) on delete cascade,
  provider text not null check (provider in ('google', 'microsoft')),
  refresh_token_ciphertext text not null,
  refresh_token_iv text not null,
  account_email text,
  calendar_id text not null default 'primary',
  scopes text[] not null default '{}',
  updated_at timestamptz not null default now(),
  primary key (user_id, provider)
);

create table if not exists public.mn_calendar_event_links (
  user_id uuid not null references auth.users(id) on delete cascade,
  provider text not null check (provider in ('google', 'microsoft')),
  meeting_id uuid not null,
  provider_event_id text not null,
  app_snapshot jsonb not null default '{}'::jsonb,
  provider_snapshot jsonb not null default '{}'::jsonb,
  provider_updated_at timestamptz,
  synced_at timestamptz not null default now(),
  primary key (user_id, provider, meeting_id),
  unique (user_id, provider, provider_event_id)
);

alter table public.mn_calendar_connections enable row level security;
alter table public.mn_calendar_event_links enable row level security;

revoke all on public.mn_calendar_connections from anon, authenticated;
revoke all on public.mn_calendar_event_links from anon, authenticated;
grant select, insert, update, delete on public.mn_calendar_connections to authenticated;
grant select, insert, update, delete on public.mn_calendar_event_links to authenticated;

create policy mn_calendar_connections_select_own
  on public.mn_calendar_connections for select to authenticated
  using ((select auth.uid()) = user_id);
create policy mn_calendar_connections_insert_own
  on public.mn_calendar_connections for insert to authenticated
  with check ((select auth.uid()) = user_id);
create policy mn_calendar_connections_update_own
  on public.mn_calendar_connections for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);
create policy mn_calendar_connections_delete_own
  on public.mn_calendar_connections for delete to authenticated
  using ((select auth.uid()) = user_id);

create policy mn_calendar_event_links_select_own
  on public.mn_calendar_event_links for select to authenticated
  using ((select auth.uid()) = user_id);
create policy mn_calendar_event_links_insert_own
  on public.mn_calendar_event_links for insert to authenticated
  with check ((select auth.uid()) = user_id);
create policy mn_calendar_event_links_update_own
  on public.mn_calendar_event_links for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);
create policy mn_calendar_event_links_delete_own
  on public.mn_calendar_event_links for delete to authenticated
  using ((select auth.uid()) = user_id);

create index if not exists mn_calendar_event_links_provider_event_idx
  on public.mn_calendar_event_links (provider, provider_event_id);
