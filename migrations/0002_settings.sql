-- Service-wide settings changed at runtime (the admin page), as JSON per key.
create table if not exists settings (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);
