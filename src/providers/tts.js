// src/providers/tts.js
// Text-to-speech provider. Returns MP3 Buffer or null.

import { config }                 from '../../config/index.js'
import { logger }                 from '../utils/logger.js'
import { withRetry, isRetryable } from '../utils/retry.js'

export async function synthesizeSpeech(script, override = {}) {
  const provider = override.tts?.provider ?? config.tts.provider
  const voice    = override.tts?.voice    ?? config.tts.voice
  const speed    = override.tts?.speed    ?? config.tts.speed

  if (provider === 'none') {
    logger.info('[tts] provider=none, skipping')
    return null
  }
  logger.info(`[tts] provider="${provider}" voice="${voice}" ${script.length} chars`)

  return withRetry(
    () => callOpenAITTS(script, voice, speed),
    { label: 'tts:openai', maxAttempts: 3, baseDelayMs: 2000, retryIf: isRetryable }
  )
}

async function callOpenAITTS(script, voice, speed) {
  const { default: OpenAI } = await import('openai')
  const client   = new OpenAI({ apiKey: config.llm.openai.apiKey })
  const response = await client.audio.speech.create({
    model:           'tts-1',
    voice:           voice,
    input:           script,
    speed:           speed,
    response_format: 'mp3',
  })
  const buffer = Buffer.from(await response.arrayBuffer())
  logger.info(`[tts:openai] ${(buffer.length / 1024).toFixed(1)}KB`)
  return buffer
}
