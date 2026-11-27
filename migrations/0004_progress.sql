-- Create progress: where a provisioning sandbox is in its setup (null otherwise).
alter table sandboxes add column if not exists progress jsonb;
