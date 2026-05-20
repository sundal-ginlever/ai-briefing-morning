-- supabase/migrations/005_add_keywords_and_fix_constraints.sql
-- Phase 6a 보완: news_keywords 컬럼 추가 + 제약조건 수정

-- 1. news_keywords 컬럼 추가
alter table a_user_settings
  add column if not exists news_keywords text[] not null default '{}';

-- 2. news_page_size 기본값을 5로 변경
alter table a_user_settings
  alter column news_page_size set default 5;

-- 3. briefing_target_secs 기본값을 150으로 변경
alter table a_user_settings
  alter column briefing_target_secs set default 150;

-- 4. tts_provider CHECK 제약조건 완화 (google 허용)
alter table a_user_settings
  drop constraint if exists a_user_settings_tts_provider_check;
alter table a_user_settings
  add constraint a_user_settings_tts_provider_check
  check (tts_provider in ('openai', 'google', 'none'));
