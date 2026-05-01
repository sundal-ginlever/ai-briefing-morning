-- supabase/migrations/001_create_briefing_logs.sql
-- Run this once in your Supabase project's SQL editor.

create table if not exists a_briefing_logs (
  id            bigserial primary key,
  date          date        not null,
  script        text        not null,
  audio_url     text,
  articles      jsonb       not null default '[]',
  llm_provider  text        not null default 'openai',
  tts_provider  text        not null default 'openai',
  duration_ms   integer,
  created_at    timestamptz not null default now()
);

-- Index for history lookup by date
create index if not exists a_briefing_logs_date_idx on a_briefing_logs (date desc);

-- Prevent duplicate runs on the same day
create unique index if not exists a_briefing_logs_date_unique on a_briefing_logs (date);

-- RLS: service role can do everything (used by the pipeline)
-- In Phase 2 when you add user auth, you'll extend these policies.
alter table a_briefing_logs enable row level security;

create policy "Service role full access"
  on a_briefing_logs
  for all
  using (true)
  with check (true);
