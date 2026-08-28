// src/providers/storage.js
// Persists audio files and returns a public/signed URL.
// Supports Supabase Storage or local filesystem.

import { config } from '../../config/index.js'
import { logger } from '../utils/logger.js'
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'

/**
 * Save audio buffer and return accessible URL.
 * @param {Buffer} audioBuffer
 * @param {string} filename  - e.g. "2025-04-24.mp3"
 * @returns {Promise<string>} - URL to the saved file
 */
export async function saveAudio(audioBuffer, filename) {
  if (!audioBuffer) {
    logger.info('[storage] no audio buffer, skipping')
    return null
  }

  switch (config.storage.provider) {
    case 'supabase': return saveToSupabase(audioBuffer, filename)
    case 'local':    return saveToLocal(audioBuffer, filename)
    default:
      throw new Error(`Unknown storage provider: ${config.storage.provider}`)
  }
}

// ─── Supabase Storage ─────────────────────────────────────────────────────────

async function saveToSupabase(audioBuffer, filename) {
  const { createClient } = await import('@supabase/supabase-js')
  const supabase = createClient(config.supabase.url, config.supabase.serviceKey)

  const { error } = await supabase.storage
    .from(config.storage.bucket)
    .upload(filename, audioBuffer, {
      contentType: 'audio/mpeg',
      upsert: true,           // overwrite if re-run same day
    })

  if (error) throw new Error(`Supabase storage upload failed: ${error.message}`)

  // 버킷이 public이므로 영구 공개 URL을 쓴다. 예전엔 7일 서명 URL을 발급했는데,
  // 파일 자체는 어차피 공개라 만료는 이메일 링크만 죽이는 자충수였고, RSS 피드는
  // 그 만료를 피하려 매 요청마다 전 회차를 재서명해야 했다(공개 히스토리에선 더 큰 부담).
  const { data } = supabase.storage.from(config.storage.bucket).getPublicUrl(filename)

  logger.info(`[storage:supabase] uploaded → ${data.publicUrl.substring(0, 60)}...`)
  return data.publicUrl
}

// ─── Local Filesystem ─────────────────────────────────────────────────────────

async function saveToLocal(audioBuffer, filename) {
  const dir = config.storage.localPath
  mkdirSync(dir, { recursive: true })

  const filePath = join(dir, filename)
  writeFileSync(filePath, audioBuffer)
  logger.info(`[storage:local] saved → ${filePath}`)

  // Return a file:// URL for local use / dev testing
  return `file://${filePath}`
}
