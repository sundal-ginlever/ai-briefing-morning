// src/api/supabase.js
// 싱글턴 Supabase 클라이언트.
// service_role 키 사용 — 서버 사이드 전용.

import { createClient } from '@supabase/supabase-js'
import { config }       from '../../config/index.js'

let _client = null

export function getSupabase() {
  if (_client) return _client
  if (!config.supabase.url || !config.supabase.serviceKey) {
    throw new Error('Supabase not configured. Set SUPABASE_URL and SUPABASE_SERVICE_KEY.')
  }
  _client = createClient(config.supabase.url, config.supabase.serviceKey, {
    auth: { persistSession: false },
  })
  return _client
}
