-- supabase/migrations/008_schedule_disabled_by_default.sql
-- 문제: a_on_auth_user_created 트리거가 공유 Supabase Auth의 모든 신규 가입자에게
--       발동되어 schedule_enabled=true(기존 default)로 a_user_settings가 생성됨.
--       → 다른 프로젝트 계정이 브리핑 스케줄러에 의해 실행되는 사이드이펙트 발생.
--
-- 수정:
--   1) schedule_enabled 기본값을 false로 변경 (신규 가입자 차단)
--   2) 기존에 잘못 schedule_enabled=true가 된 타 프로젝트 계정 비활성화
--      (본인 계정 이메일 = intothekie@gmail.com 은 유지)

-- 1) 기본값 변경
ALTER TABLE a_user_settings
  ALTER COLUMN schedule_enabled SET DEFAULT false;

-- 2) 본인 외 모든 유저의 스케줄 비활성화
UPDATE a_user_settings
SET schedule_enabled = false
WHERE user_id NOT IN (
  SELECT id FROM a_user_profiles WHERE email = 'intothekie@gmail.com'
);
