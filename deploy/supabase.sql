create table if not exists public.ticket_state (
  id text primary key,
  data jsonb not null,
  updated_at timestamptz not null default now()
);

create table if not exists public.ticket_events (
  id uuid primary key,
  occurred_at timestamptz not null,
  payload jsonb not null
);

create index if not exists ticket_events_occurred_at_idx
  on public.ticket_events (occurred_at);

alter table public.ticket_state enable row level security;
alter table public.ticket_events enable row level security;

revoke all on public.ticket_state from anon, authenticated;
revoke all on public.ticket_events from anon, authenticated;

grant select, insert, update, delete on public.ticket_state to service_role;
grant select, insert, update, delete on public.ticket_events to service_role;
