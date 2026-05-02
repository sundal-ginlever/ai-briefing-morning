// src/api/users.js
// 사용자 설정 CRUD 서비스.
// 파이프라인과 REST API 양쪽에서 사용.

import { getSupabase } from './supabase.js'
import { logger }      from '../utils/logger.js'

// ─── 조회 ─────────────────────────────────────────────────────────────────────

/**
 * 스케줄이 활성화된 사용자 중, 현재 시간(UTC) 이하로 설정된 모든 사용자를 가져옴.
 * (GitHub Actions의 지연 실행에 대비하기 위함)
 * @param {number} hourUtc - 현재 UTC 시간 (0-23)
 */
export async function getActiveUsersToProcess(hourUtc) {
  const sb = getSupabase()
  const { data, error } = await sb
    .from('a_user_settings')
    .select(`
      news_country, news_categories, news_page_size,
      llm_provider, llm_model,
      tts_provider, tts_voice, tts_speed,
      briefing_language, briefing_target_secs, custom_prompt,
      schedule_hour_utc, timezone, delivery_email,
      schedule_enabled,
      a_user_profiles!inner (id, email, display_name, is_active)
    `)
    .eq('schedule_enabled', true)
    .lte('schedule_hour_utc', hourUtc)  // 현재 시간 이하인 모든 유저
    .eq('a_user_profiles.is_active', true)

  if (error) throw new Error(`getActiveUsersToProcess failed: ${error.message}`)
  return data ?? []
}

/**
 * 특정 날짜에 이미 브리핑 로그가 있는지 확인.
 */
export async function hasLogForDate(userId, date) {
  const sb = getSupabase()
  const { count, error } = await sb
    .from('a_briefing_logs')
    .select('*', { count: 'exact', head: true })
    .eq('user_id', userId)
    .eq('date', date)

  if (error) throw new Error(`hasLogForDate failed: ${error.message}`)
  return count > 0
}

/**
 * 특정 사용자의 설정 조회.
 */
export async function getUserSettings(userId) {
  const sb = getSupabase()
  const { data, error } = await sb
    .from('a_user_settings')
    .select('*')
    .eq('user_id', userId)
    .single()

  if (error) throw new Error(`getUserSettings failed: ${error.message}`)
  return data
}

/**
 * 특정 사용자의 브리핑 히스토리 조회.
 * Phase 3: articles(대량 JSON)를 제외하여 응답 크기 최소화.
 * @param {string} userId
 * @param {number} limit
 */
export async function getBriefingHistory(userId, limit = 30) {
  const sb = getSupabase()
  const { data, error } = await sb
    .from('a_briefing_logs')
    .select('id, date, script, audio_url, llm_provider, tts_provider, duration_ms, created_at')
    .eq('user_id', userId)
    .order('date', { ascending: false })
    .limit(limit)

  if (error) throw new Error(`getBriefingHistory failed: ${error.message}`)
  return data ?? []
}

// ─── 수정 ─────────────────────────────────────────────────────────────────────

/**
 * 사용자 설정 업데이트 (부분 업데이트 지원).
 * Phase 4: custom_prompt, timezone 허용 필드 추가
 * @param {string} userId
 * @param {Partial<UserSettings>} patch
 */
export async function updateUserSettings(userId, patch) {
  // 허용된 필드만 통과
  const allowed = [
    'news_country', 'news_categories', 'news_page_size',
    'llm_provider', 'llm_model',
    'tts_provider', 'tts_voice', 'tts_speed',
    'briefing_language', 'briefing_target_secs', 'custom_prompt',
    'schedule_hour_utc', 'timezone', 'schedule_enabled',
    'delivery_email',
  ]
  const safe = Object.fromEntries(
    Object.entries(patch).filter(([k]) => allowed.includes(k))
  )

  if (Object.keys(safe).length === 0) {
    throw new Error('No valid fields to update')
  }

  const sb = getSupabase()
  const { data, error } = await sb
    .from('a_user_settings')
    .update(safe)
    .eq('user_id', userId)
    .select()
    .single()

  if (error) throw new Error(`updateUserSettings failed: ${error.message}`)
  logger.info(`[users] Settings updated for userId=${userId}`)
  return data
}

/**
 * DB 로그에 user_id 추가 (파이프라인 완료 후 호출).
 */
export async function assignLogToUser(logId, userId) {
  const sb = getSupabase()
  const { error } = await sb
    .from('a_briefing_logs')
    .update({ user_id: userId })
    .eq('id', logId)

  if (error) logger.warn(`[users] assignLogToUser failed: ${error.message}`)
}

// ─── 헬퍼: DB 설정 → 파이프라인 override 변환 ────────────────────────────────

/**
 * user_settings 레코드를 runner.js가 받는 override 형태로 변환.
 */
export function settingsToOverride(s) {
  return {
    news: {
      country:    s.news_country,
      categories: s.news_categories,
      pageSize:   s.news_page_size,
    },
    llm: {
      provider: s.llm_provider,
      model:    s.llm_model,
    },
    tts: {
      voice: s.tts_voice,
      speed: s.tts_speed,
    },
    briefing: {
      language:      s.briefing_language,
      targetSeconds: s.briefing_target_secs,
      customPrompt:  s.custom_prompt,
    },
    schedule: {
      hourUtc:  s.schedule_hour_utc,
      timezone: s.timezone,
    },
    email: {
      to: s.delivery_email,   // null이면 계정 이메일 사용
    },
  }
}
