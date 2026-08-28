// config/index.js
// Central configuration loader.
// All pipeline modules import from here — never directly from process.env.

import 'dotenv/config'

function required(key) {
  const val = process.env[key]
  if (!val) throw new Error(`Missing required environment variable: ${key}`)
  return val
}

function optional(key, defaultValue = '') {
  return process.env[key] ?? defaultValue
}

const VALID_LLM_PROVIDERS = ['openai', 'gemini', 'ollama']
const VALID_TTS_PROVIDERS = ['openai', 'google', 'gemini', 'none']
const VALID_STORAGE       = ['supabase', 'local']
const VALID_EMAIL         = ['smtp', 'none']

function validateChoice(key, value, valid) {
  if (!valid.includes(value))
    throw new Error(`${key}="${value}" is invalid. Choose from: ${valid.join(', ')}`)
  return value
}

const llmProvider     = validateChoice('LLM_PROVIDER',     optional('LLM_PROVIDER',     'gemini'), VALID_LLM_PROVIDERS)
const ttsProvider     = validateChoice('TTS_PROVIDER',     optional('TTS_PROVIDER',     'openai'), VALID_TTS_PROVIDERS)
const storageProvider = validateChoice('STORAGE_PROVIDER', optional('STORAGE_PROVIDER', 'local'),  VALID_STORAGE)
const emailProvider   = validateChoice('EMAIL_PROVIDER',   optional('EMAIL_PROVIDER',   'none'),   VALID_EMAIL)

export const config = {
  news: {
    // 지연 평가 — 뉴스를 실제로 가져올 때만 강제한다.
    // 맥미니 로컬 TTS 워커처럼 뉴스와 무관한 진입점이 이 키 없이도 돌아야 하기 때문.
    get apiKey() { return required('NEWS_API_KEY') },
    country:    optional('NEWS_COUNTRY',    'us'),
    categories: optional('NEWS_CATEGORIES', 'general,technology').split(',').map(c => c.trim()),
    keywords:   optional('NEWS_KEYWORDS', '').split(',').map(k => k.trim()).filter(Boolean),
    pageSize:   parseInt(optional('NEWS_PAGE_SIZE', '5'), 10),
  },
  llm: {
    provider: llmProvider,
    openai:  { apiKey: optional('OPENAI_API_KEY'), model: optional('OPENAI_MODEL', 'gpt-4o-mini') },
    gemini:  { apiKey: optional('GEMINI_API_KEY'), model: optional('GEMINI_MODEL', 'gemini-2.5-flash') },
    ollama:  { baseUrl: optional('OLLAMA_BASE_URL', 'http://localhost:11434'), model: optional('OLLAMA_MODEL', 'llama3.2') },
  },
  tts: {
    provider: ttsProvider,
    openai:  { apiKey: optional('OPENAI_API_KEY') },
    google:  { apiKey: optional('GOOGLE_API_KEY', process.env.GEMINI_API_KEY) },
    gemini:  {
      apiKey: optional('GEMINI_API_KEY'),
      model:  optional('GEMINI_TTS_MODEL', 'gemini-3.1-flash-tts-preview'),
      voice:  optional('GEMINI_TTS_VOICE', 'Sulafat'),
      // 단락별 멀티보이스 로테이션 (입력 순서대로 순환, 마지막 보이스가 마무리 담당)
      voices: optional('GEMINI_TTS_VOICES', 'Sulafat,Fenrir,Erinome,Sadachbia,Zephyr')
        .split(',').map(v => v.trim()).filter(Boolean),
      // 세그먼트 최대 길이(자). 초과 단락은 문장 경계로 분할해 휘파람 드리프트 방지
      maxSegmentChars: parseInt(optional('GEMINI_TTS_MAX_SEGMENT_CHARS', '400'), 10),
      // 무료티어 3 RPM 방어용 세그먼트 간 대기 (ms)
      segmentDelayMs: parseInt(optional('GEMINI_TTS_SEGMENT_DELAY_MS', '21000'), 10),
    },
    voice:    optional('TTS_VOICE', 'coral'),
    speed:    parseFloat(optional('TTS_SPEED', '0.95')),
  },
  supabase: {
    url:        optional('SUPABASE_URL'),
    serviceKey: optional('SUPABASE_SERVICE_KEY'),
  },
  storage: {
    provider:  storageProvider,
    bucket:    optional('STORAGE_BUCKET',     'ai-briefing-audio'),
    localPath: optional('LOCAL_STORAGE_PATH', './output'),
  },
  email: {
    provider: emailProvider,
    smtp: {
      host: optional('SMTP_HOST', 'smtp.gmail.com'),
      port: parseInt(optional('SMTP_PORT', '587'), 10),
      user: optional('SMTP_USER'),
      pass: optional('SMTP_PASS'),
    },
    to:   optional('EMAIL_TO'),
    from: optional('EMAIL_FROM'),
  },
  briefing: {
    language:       optional('BRIEFING_LANGUAGE',       'English'),
    // 총 길이 3분. 기사당 목표는 여기서 파생시키므로(llm.js) 따로 두지 않는다 —
    // 총합과 기사당을 각각 설정하던 시절 DB(120s)와 env(기사당 40s)가 어긋나
    // "총 120초인데 기사당 40초×5" 라는 모순된 프롬프트가 나갔던 전례가 있다.
    targetSeconds:  parseInt(optional('BRIEFING_TARGET_SECONDS', '180'), 10),
    // 인사+마무리에 배정하는 고정 여유. 기사당 = (총목표 - 이 값) / 기사수
    introOutroSeconds: parseInt(optional('BRIEFING_INTRO_OUTRO_SECONDS', '30'), 10),
  },
}
