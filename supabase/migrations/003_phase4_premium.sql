-- supabase/migrations/003_phase4_premium.sql
-- Phase 4: 프리미엄 기능 도입을 위한 컬럼 추가

-- 1. 커스텀 프롬프트 필드 추가
alter table a_user_settings
  add column if not exists custom_prompt text;

-- 2. 사용자별 타임존 필드 추가 (기본값 KST)
alter table a_user_settings
  add column if not exists timezone text not null default 'Asia/Seoul';

-- 기존 schedule_hour_utc를 유지하되, 대시보드에서는 timezone 기반 local hour를 설정하게 됨
-- 파이프라인은 그대로 UTC 매 정시에 돌면서, 해당 UTC 시간에 매칭되는 유저를 가져옴
