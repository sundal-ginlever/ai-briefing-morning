-- supabase/migrations/009_add_gemini_tts_provider.sql
-- TTS를 Gemini로 전환하면서 tts_provider CHECK 제약에 'gemini' 추가.
-- (005에서 'openai','google','none'만 허용 → 'gemini' insert/update 시 제약 위반)

-- 1) CHECK 제약 갱신
alter table a_user_settings
  drop constraint if exists a_user_settings_tts_provider_check;
alter table a_user_settings
  add constraint a_user_settings_tts_provider_check
  check (tts_provider in ('openai', 'google', 'gemini', 'none'));

-- 2) 본인 계정 TTS를 Gemini + Kore 보이스로 전환
update a_user_settings
set tts_provider = 'gemini', tts_voice = 'Kore'
where user_id in (
  select id from a_user_profiles where email = 'intothekie@gmail.com'
);
