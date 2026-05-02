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

  const task = provider === 'google' 
    ? () => callGoogleTTS(script, voice, speed)
    : () => callOpenAITTS(script, voice, speed)

  return withRetry(task, { 
    label: `tts:${provider}`, 
    maxAttempts: 3, 
    baseDelayMs: 2000, 
    retryIf: isRetryable 
  })
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

async function callGoogleTTS(script, voice, speed) {
  const apiKey = config.tts.google.apiKey
  if (!apiKey) throw new Error('GOOGLE_API_KEY is missing')

  // voice 형식 예시: ko-KR-Neural2-A, en-US-Wavenet-D
  const languageCode = voice.split('-').slice(0, 2).join('-')
  
  const payload = {
    input: { text: script },
    voice: { languageCode, name: voice },
    audioConfig: {
      audioEncoding: 'MP3',
      speakingRate:  speed,
    }
  }

  const res = await fetch(`https://texttospeech.googleapis.com/v1/text:synthesize?key=${apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })

  if (!res.ok) {
    const errorData = await res.json()
    throw new Error(`Google TTS API ${res.status}: ${errorData.error?.message || 'Unknown error'}`)
  }

  const data = await res.json()
  const buffer = Buffer.from(data.audioContent, 'base64')
  logger.info(`[tts:google] voice=${voice} ${(buffer.length / 1024).toFixed(1)}KB`)
  return buffer
}
