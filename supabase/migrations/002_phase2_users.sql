-- supabase/migrations/002_phase2_users.sql
-- Phase 2: 사용자 관리 + 개인 설정
-- Supabase SQL Editor에서 실행

-- ── 1. 사용자 프로필 (Supabase Auth와 연동) ──────────────────────────────────
create table if not exists a_user_profiles (
  id           uuid primary key references auth.users(id) on delete cascade,
  email        text not null,
  display_name text,
  is_active    boolean     not null default true,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- ── 2. 사용자별 브리핑 설정 ──────────────────────────────────────────────────
create table if not exists a_user_settings (
  id                   bigserial primary key,
  user_id              uuid not null references a_user_profiles(id) on delete cascade,

  -- 뉴스 설정
  news_country         text    not null default 'us',
  news_categories      text[]  not null default '{general,technology}',
  news_page_size       integer not null default 3
                         check (news_page_size between 1 and 10),

  -- LLM 설정
  llm_provider         text    not null default 'openai'
                         check (llm_provider in ('openai','gemini','ollama')),
  llm_model            text    not null default 'gpt-4o-mini',

  -- TTS 설정
  tts_provider         text    not null default 'openai'
                         check (tts_provider in ('openai','none')),
  tts_voice            text    not null default 'coral',
  tts_speed            numeric not null default 0.9
                         check (tts_speed between 0.5 and 2.0),

  -- 브리핑 내용
  briefing_language    text    not null default 'English',
  briefing_target_secs integer not null default 60
                         check (briefing_target_secs between 30 and 300),

  -- 스케줄 설정
  schedule_hour_utc    integer not null default 23   -- 23:00 UTC = 08:00 KST
                         check (schedule_hour_utc between 0 and 23),
  schedule_enabled     boolean not null default true,

  -- 이메일 수신처 (기본은 계정 이메일)
  delivery_email       text,

  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),

  unique (user_id)   -- 사용자당 하나의 설정
);

-- ── 3. a_briefing_logs에 user_id 컬럼 추가 ────────────────────────────────────
alter table a_briefing_logs
  add column if not exists user_id uuid references a_user_profiles(id) on delete set null;

-- 기존의 단일 유저용 하루 1개 제한 인덱스 삭제
drop index if exists a_briefing_logs_date_unique;

-- 유저별 하루 1개 제한으로 변경
create unique index if not exists a_briefing_logs_user_date_unique
  on a_briefing_logs (user_id, date desc);

-- ── 4. RLS 정책 ──────────────────────────────────────────────────────────────
alter table a_user_profiles enable row level security;
alter table a_user_settings  enable row level security;

-- 본인 프로필만 조회/수정
create policy "Users read own profile"
  on a_user_profiles for select using (auth.uid() = id);
create policy "Users update own profile"
  on a_user_profiles for update using (auth.uid() = id);

-- 본인 설정만 조회/수정/생성
create policy "Users manage own settings"
  on a_user_settings for all using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- 본인 로그만 조회
create policy "Users read own logs"
  on a_briefing_logs for select using (auth.uid() = user_id);

-- Service role은 모든 테이블 접근 가능 (파이프라인용)
-- (service_role은 RLS를 우회하므로 별도 정책 불필요)

-- ── 5. 신규 사용자 가입 시 기본 레코드 자동 생성 트리거 ─────────────────────
create or replace function a_handle_new_user()
returns trigger language plpgsql security definer as $$
begin
  insert into a_user_profiles (id, email, display_name)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data->>'full_name', split_part(new.email, '@', 1))
  ) on conflict (id) do nothing;
  insert into a_user_settings (user_id) values (new.id) on conflict (user_id) do nothing;
  return new;
end;
$$;

drop trigger if exists a_on_auth_user_created on auth.users;
create trigger a_on_auth_user_created
  after insert on auth.users
  for each row execute function a_handle_new_user();

-- ── 6. updated_at 자동 갱신 트리거 ──────────────────────────────────────────
create or replace function touch_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end;
$$;

create trigger touch_a_user_profiles
  before update on a_user_profiles
  for each row execute function touch_updated_at();

create trigger touch_a_user_settings
  before update on a_user_settings
  for each row execute function touch_updated_at();
