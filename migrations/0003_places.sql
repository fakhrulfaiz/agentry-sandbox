-- Places: named, configured locations sandboxes run in (kind + config + sealed credentials).
create table if not exists places (
  id text primary key,
  name text not null,
  kind text not null,
  config jsonb not null default '{}',
  secrets text,
  enabled boolean not null default true,
  is_default boolean not null default false,
  max_running integer,
  gpus jsonb,
  created_at timestamptz not null,
  updated_at timestamptz not null
);
create unique index if not exists places_one_default on places (is_default) where is_default;
alter table sandboxes add column if not exists handle_secrets text;
update sandboxes set backend = 'local' where backend = 'docker';
