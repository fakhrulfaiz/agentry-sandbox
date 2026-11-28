-- Snapshots: saved copies of a sandbox. Owner-scoped; kept after the source sandbox is deleted.
create table if not exists snapshots (
  id             text primary key,
  owner          text not null,
  sandbox_id     text not null,
  place          text not null,
  level          text not null check (level in ('workspace', 'disk', 'memory')),
  name           text not null,
  state          text not null check (state in ('saving', 'ready', 'failed')),
  handle         jsonb not null default '{}'::jsonb,
  handle_secrets text,
  size_bytes     bigint,
  error          text,
  created_at     timestamptz not null,
  expires_at     timestamptz
);
create index if not exists snapshots_owner_idx on snapshots (owner, created_at);
create index if not exists snapshots_sandbox_idx on snapshots (sandbox_id);
create index if not exists snapshots_expires_idx on snapshots (expires_at) where expires_at is not null;
