create table if not exists public.orbi_state (
  id integer primary key check (id = 1),
  revision bigint not null default 0,
  snapshot jsonb not null default '{"piAt":null,"esp32At":null,"commands":[]}'::jsonb
);
alter table public.orbi_state enable row level security;
revoke all on public.orbi_state from anon, authenticated;
grant select, update on public.orbi_state to service_role;
insert into public.orbi_state (id) values (1) on conflict do nothing;
