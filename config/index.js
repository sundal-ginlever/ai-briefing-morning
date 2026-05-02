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
const VALID_TTS_PROVIDERS = ['openai', 'none']
const VALID_STORAGE       = ['supabase', 'local']
const VALID_EMAIL         = ['smtp', 'none']

function validateChoice(key, value, valid) {
  if (!valid.includes(value))
    throw new Error(`${key}="${value}" is invalid. Choose from: ${valid.join(', ')}`)
  return value
}

const llmProvider     = validateChoice('LLM_PROVIDER',     optional('LLM_PROVIDER',     'openai'), VALID_LLM_PROVIDERS)
const ttsProvider     = validateChoice('TTS_PROVIDER',     optional('TTS_PROVIDER',     'openai'), VALID_TTS_PROVIDERS)
const storageProvider = validateChoice('STORAGE_PROVIDER', optional('STORAGE_PROVIDER', 'local'),  VALID_STORAGE)
const emailProvider   = validateChoice('EMAIL_PROVIDER',   optional('EMAIL_PROVIDER',   'none'),   VALID_EMAIL)

export const config = {
  news: {
    apiKey:     required('NEWS_API_KEY'),
    country:    optional('NEWS_COUNTRY',    'us'),
    categories: optional('NEWS_CATEGORIES', 'general').split(',').map(c => c.trim()),
    pageSize:   parseInt(optional('NEWS_PAGE_SIZE', '3'), 10),
  },
  llm: {
    provider: llmProvider,
    openai:  { apiKey: optional('OPENAI_API_KEY'), model: optional('OPENAI_MODEL', 'gpt-4o-mini') },
    gemini:  { apiKey: optional('GEMINI_API_KEY'), model: optional('GEMINI_MODEL', 'gemini-2.5-flash') },
    ollama:  { baseUrl: optional('OLLAMA_BASE_URL', 'http://localhost:11434'), model: optional('OLLAMA_MODEL', 'llama3.2') },
  },
  tts: {
    provider: ttsProvider,
    voice:    optional('TTS_VOICE', 'coral'),
    speed:    parseFloat(optional('TTS_SPEED', '0.9')),
  },
  supabase: {
    url:        optional('SUPABASE_URL'),
    serviceKey: optional('SUPABASE_SERVICE_KEY'),
    anonKey:    optional('SUPABASE_ANON_KEY'),   // ← 대시보드 클라이언트 인증용
  },
  storage: {
    provider:  storageProvider,
    bucket:    optional('STORAGE_BUCKET',     'briefing-audio'),
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
    language:      optional('BRIEFING_LANGUAGE',       'English'),
    targetSeconds: parseInt(optional('BRIEFING_TARGET_SECONDS', '60'), 10),
  },
  server: {
    adminEmails: optional('ADMIN_EMAILS', '').split(',').map(e => e.trim()).filter(Boolean),
    runSecret:   optional('RUN_SECRET'),
  },
}
