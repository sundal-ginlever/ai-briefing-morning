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
