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

  // Generate a signed URL valid for 7 days (recipients get a week to listen)
  const { data, error: signError } = await supabase.storage
    .from(config.storage.bucket)
    .createSignedUrl(filename, 60 * 60 * 24 * 7)

  if (signError) throw new Error(`Supabase signed URL failed: ${signError.message}`)

  logger.info(`[storage:supabase] uploaded → ${data.signedUrl.substring(0, 60)}...`)
  return data.signedUrl
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
