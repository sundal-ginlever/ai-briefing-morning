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

  // gemini는 세그먼트별 자체 재시도가 있어 바깥 재시도로 감싸지 않는다
  // (전체 재실행 시 무료티어 쿼터가 세그먼트 수만큼 배로 소진됨)
  if (provider === 'gemini') return callGeminiTTS(script, voice)

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

// OpenAI 전용 보이스 — Gemini에 넘기면 에러나므로 기본 보이스로 폴백 처리
const OPENAI_VOICES = new Set(['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer', 'coral', 'sage', 'ash'])

// 세그먼트 사이 무음 0.5초 (L16 24kHz mono = 24000샘플/초 × 2바이트 × 0.5초)
const SEGMENT_SILENCE = Buffer.alloc(24000, 0)

const sleep = ms => new Promise(r => setTimeout(r, ms))

/**
 * 멀티보이스 Gemini TTS.
 * 긴 스크립트를 한 번에 합성하면 뒷부분에서 속삭임/휘파람 톤으로 드리프트하는
 * 현상이 있어, 단락별로 분할해 보이스를 로테이션하며 개별 합성한 뒤
 * PCM 단계에서 무음과 함께 이어붙이고 마지막에 한 번만 MP3로 변환한다.
 */
async function callGeminiTTS(script, voice) {
  const apiKey = config.tts.gemini.apiKey
  if (!apiKey) throw new Error('GEMINI_API_KEY is missing for Gemini TTS')

  const model = config.tts.gemini.model

  // 보이스 로테이션: 유저 지정 보이스가 선두, 이어서 목록의 나머지 보이스 순환
  const primary  = (!voice || OPENAI_VOICES.has(voice)) ? config.tts.gemini.voice : voice
  const rotation = [primary, ...config.tts.gemini.voices.filter(v => v.toLowerCase() !== primary.toLowerCase())]

  const segments = splitIntoSegments(script, rotation.length)
  logger.info(`[tts:gemini] ${segments.length} segment(s), voices=[${rotation.slice(0, segments.length).join(', ')}]`)

  const pcmParts = []
  for (let i = 0; i < segments.length; i++) {
    // 무료티어 3 RPM 방어 — 첫 세그먼트 이후부터 간격 유지
    if (i > 0 && config.tts.gemini.segmentDelayMs > 0) await sleep(config.tts.gemini.segmentDelayMs)

    const segVoice = rotation[i % rotation.length]
    const pcm = await withRetry(
      () => synthesizeGeminiSegment(segments[i], segVoice, model, apiKey),
      { label: `tts:gemini:seg${i + 1}/${segments.length}(${segVoice})`, maxAttempts: 3, baseDelayMs: 10000, maxDelayMs: 30000, retryIf: isRetryable }
    )
    logger.info(`[tts:gemini] segment ${i + 1}/${segments.length} voice=${segVoice} PCM ${(pcm.length / 1024).toFixed(1)}KB`)

    if (pcmParts.length > 0) pcmParts.push(SEGMENT_SILENCE)
    pcmParts.push(pcm)
  }

  const merged = Buffer.concat(pcmParts)
  logger.info(`[tts:gemini] merged PCM ${(merged.length / 1024).toFixed(1)}KB → MP3`)
  return pcmToMp3(merged)
}

/** 스크립트를 최대 maxSegments개의 단락 그룹으로 분할 (export는 테스트용) */
export function splitIntoSegments(script, maxSegments) {
  // 1) 빈 줄 기준 단락 분할
  let parts = script.split(/\n\s*\n+/).map(s => s.trim()).filter(Boolean)

  // 2) 단락 구분이 없으면 문장 단위로 등분
  if (parts.length === 1) {
    const sentences = parts[0].match(/[^.!?]+[.!?]+["')\]]*\s*/g) || [parts[0]]
    parts = groupEvenly(sentences, Math.min(maxSegments, sentences.length)).map(g => g.join('').trim())
  }

  // 3) 단락이 보이스 수보다 많으면 인접 단락을 묶어 압축
  if (parts.length > maxSegments) {
    parts = groupEvenly(parts, maxSegments).map(g => g.join('\n\n'))
  }

  return parts.filter(Boolean)
}

/** items를 n개 그룹으로 최대한 균등하게 나눔 (순서 유지) */
function groupEvenly(items, n) {
  const groups = []
  let start = 0
  for (let i = 0; i < n && start < items.length; i++) {
    const size = Math.ceil((items.length - start) / (n - i))
    groups.push(items.slice(start, start + size))
    start += size
  }
  return groups
}

/** 단일 세그먼트를 Gemini TTS로 합성해 PCM(L16 24kHz mono) 버퍼 반환 */
async function synthesizeGeminiSegment(text, voiceName, model, apiKey) {
  // 스타일 형용사(warm/friendly 등)나 pause 지시는 Gemini native TTS가 과장해서
  // 속삭이듯 늘어지는 톤으로 해석하는 경향이 있어 최소한의 담백한 지시만 사용한다.
  const prompt = `Read the following text aloud clearly at a normal, steady speaking pace, like a standard news broadcast.\n\n${text}`

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          responseModalities: ['AUDIO'],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName } } },
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

  return Buffer.from(b64, 'base64')
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
