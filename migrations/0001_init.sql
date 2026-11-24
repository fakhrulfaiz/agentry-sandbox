-- Sandboxes and templates. Every row carries its owner; times are timestamptz.
create table templates (
  id          text primary key,
  owner       text not null,
  name        text not null,
  spec        jsonb not null,
  created_at  timestamptz not null,
  updated_at  timestamptz not null
);
create index templates_owner_idx on templates (owner, created_at);

create table sandboxes (
  id           text primary key,
  owner        text not null,
  name         text not null,
  backend      text not null,
  template     jsonb not null,
  template_id  text,
  state        text not null check (state in ('provisioning', 'running', 'stopped', 'failed', 'deleting')),
  handle       jsonb not null default '{}'::jsonb,
  error        text,
  created_at   timestamptz not null,
  started_at   timestamptz,
  last_used_at timestamptz
);
create index sandboxes_owner_idx on sandboxes (owner, created_at);
