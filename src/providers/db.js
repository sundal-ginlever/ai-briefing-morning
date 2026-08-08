// src/providers/db.js
// Supabase DB 로그 저장. Supabase 미설정 시 gracefully skip.

import { config } from '../../config/index.js'
import { logger }  from '../utils/logger.js'

let _client = null

async function getClient() {
  if (_client) return _client
  if (!config.supabase.url || !config.supabase.serviceKey) return null
  const { createClient } = await import('@supabase/supabase-js')
  _client = createClient(config.supabase.url, config.supabase.serviceKey, {
    auth: { persistSession: false },
  })
  return _client
}

export async function saveBriefingLog(record) {
  const supabase = await getClient()
  if (!supabase) {
    logger.info('[db] Supabase not configured, skipping log')
    return null
  }

  const { data, error } = await supabase.from('a_briefing_logs').insert({
    user_id:      record.userId      ?? null,
    date:         record.date,
    script:       record.script,
    audio_url:    record.audioUrl    ?? null,
    articles:     record.articles,
    llm_provider: record.llmProvider,
    tts_provider: record.ttsProvider,
    duration_ms:  record.durationMs,
    created_at:   new Date().toISOString(),
  }).select('id').single()

  if (error) {
    logger.warn(`[db] Failed to save log: ${error.message}`)
    return null
  }

  logger.info(`[db] Log saved id=${data.id}`)
  return data.id
}

// ─── 로컬 TTS 큐 (맥미니 워커용) ──────────────────────────────────────────────
//
// Actions는 뉴스+대본까지만 처리하고 audio_url=null로 로그를 남긴다.
// 맥미니 워커가 그 행을 집어 음성을 만들고 채워 넣는다.
// 맥미니가 꺼져 있던 날도 켜지면 밀린 만큼 따라잡는다.

/**
 * 음성이 아직 없는 브리핑 로그 조회 (오래된 것부터).
 * @param {number} days 며칠 전까지 따라잡을지
 */
export async function getPendingAudioLogs(days = 3) {
  const supabase = await getClient()
  if (!supabase) throw new Error('Supabase not configured')

  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
  const { data, error } = await supabase
    .from('a_briefing_logs')
    .select('id, user_id, date, script, articles, audio_url, created_at')
    .is('audio_url', null)
    .gte('date', since)
    .order('date', { ascending: true })

  if (error) throw new Error(`getPendingAudioLogs failed: ${error.message}`)
  return data ?? []
}

/**
 * 음성 생성 완료 후 audio_url 채우기.
 * durationMs를 함께 갱신하지 않으면 RSS 피드의 itunes:duration이
 * skipAudio 단계에서 저장된 값(대본 생성까지의 소요시간)으로 남아
 * 실제 오디오 길이와 어긋난다.
 */
export async function updateLogAudio(logId, audioUrl, ttsProvider = 'vibevoice', durationMs = null) {
  const supabase = await getClient()
  if (!supabase) throw new Error('Supabase not configured')

  const patch = { audio_url: audioUrl, tts_provider: ttsProvider }
  if (durationMs != null) patch.duration_ms = durationMs

  const { error } = await supabase
    .from('a_briefing_logs')
    .update(patch)
    .eq('id', logId)

  if (error) throw new Error(`updateLogAudio failed: ${error.message}`)
  logger.info(`[db] audio_url 갱신 id=${logId}`)
}

/** 수신 이메일 결정 — delivery_email 우선, 없으면 계정 이메일. */
export async function getRecipientEmail(userId) {
  const supabase = await getClient()
  if (!supabase || !userId) return null

  const { data: settings } = await supabase
    .from('a_user_settings').select('delivery_email').eq('user_id', userId).maybeSingle()
  if (settings?.delivery_email) return settings.delivery_email

  const { data: profile } = await supabase
    .from('a_user_profiles').select('email').eq('id', userId).maybeSingle()
  return profile?.email ?? null
}
