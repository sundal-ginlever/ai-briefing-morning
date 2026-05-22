-- supabase/migrations/007_phase7_remove_used_in_briefing.sql

-- 1. Drop the unused index
drop index if exists idx_news_pool_unused;

-- 2. Drop the column
alter table a_news_pool drop column if exists used_in_briefing;
