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
    : provider === 'gemini'
    ? () => callGeminiTTS(script, voice)
    : () => callOpenAITTS(script, voice, speed)

  return withRetry(task, {
    label: `tts:${provider}`,
    maxAttempts: 3,
    baseDelayMs: 2000,
    retryIf: isRetryable
  })
}

// OpenAI 전용 보이스 — Gemini에 넘기면 에러나므로 Kore로 폴백 처리
const OPENAI_VOICES = new Set(['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer', 'coral', 'sage', 'ash'])

async function callGeminiTTS(script, voice) {
  const apiKey = config.tts.gemini.apiKey
  if (!apiKey) throw new Error('GEMINI_API_KEY is missing for Gemini TTS')

  const model    = config.tts.gemini.model
  const useVoice = OPENAI_VOICES.has(voice) ? config.tts.gemini.voice : (voice || config.tts.gemini.voice)

  // 단일 호출: 전체 브리핑을 한 번에. pause는 자연어 지시로 처리.
  const prompt = `Read the following morning news briefing aloud in a warm, friendly radio-anchor voice at a natural, moderate pace. Pause briefly between stories.\n\n${script}`

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          responseModalities: ['AUDIO'],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: useVoice } } },
        },
      }),
    }
  )

  if (!res.ok) {
    const body = await res.text()
    const err  = new Error(`Gemini TTS ${res.status}: ${body}`)
    err.status = res.status
    throw err
  }

  const data = await res.json()
  const b64  = data.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data
  if (!b64) throw new Error('Gemini TTS returned no audio')

  const pcm = Buffer.from(b64, 'base64')
  logger.info(`[tts:gemini] voice=${useVoice} PCM ${(pcm.length / 1024).toFixed(1)}KB → MP3`)
  return pcmToMp3(pcm)
}

// Gemini TTS는 raw PCM(L16 24kHz mono)을 반환 → ffmpeg로 MP3 변환
async function pcmToMp3(pcm) {
  const { execSync } = await import('child_process')
  const { writeFileSync, readFileSync, unlinkSync, existsSync } = await import('fs')
  const { join } = await import('path')
  const ts      = Date.now()
  const inPath  = join(process.cwd(), `temp_tts_${ts}.pcm`)
  const outPath = join(process.cwd(), `temp_tts_${ts}.mp3`)
  try {
    writeFileSync(inPath, pcm)
    execSync(`ffmpeg -y -f s16le -ar 24000 -ac 1 -i "${inPath}" -c:a libmp3lame -b:a 128k "${outPath}"`, { stdio: 'ignore' })
    const mp3 = readFileSync(outPath)
    logger.info(`[tts:gemini] MP3 ${(mp3.length / 1024).toFixed(1)}KB`)
    return mp3
  } finally {
    for (const p of [inPath, outPath]) {
      if (existsSync(p)) try { unlinkSync(p) } catch (_) {}
    }
  }
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
