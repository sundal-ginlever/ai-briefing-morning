// src/api/router.js
// Phase 2 REST API 라우터.
// Express 없이 Node.js 기본 http 모듈 기반 (src/index.js에서 마운트).
//
// 엔드포인트:
//   GET  /api/me                → 내 프로필 + 설정
//   PUT  /api/me/settings       → 설정 변경
//   GET  /api/history           → 브리핑 히스토리
//   POST /api/run               → 수동 실행 (즉시)
//   GET  /api/admin/users       → 전체 사용자 목록 (admin only)

import { getUserSettings, updateUserSettings, getBriefingHistory } from './users.js'
import { getSupabase }   from './supabase.js'
import { runPipeline, runScheduledUsers } from '../pipeline/runner.js'
import { logger }        from '../utils/logger.js'
import { config }        from '../../config/index.js'

// ─── JWT 검증 (Supabase Auth) ─────────────────────────────────────────────────

async function verifyToken(req) {
  const auth = req.headers['authorization'] ?? ''
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null
  if (!token) return null

  const sb = getSupabase()
  const { data, error } = await sb.auth.getUser(token)
  if (error || !data.user) return null
  return data.user
}

function isAdmin(user) {
  // Supabase 커스텀 claim 또는 환경변수로 관리자 판별
  const adminEmails = (process.env.ADMIN_EMAILS ?? '').split(',').map(e => e.trim())
  return adminEmails.includes(user.email)
}

// ─── 응답 헬퍼 ───────────────────────────────────────────────────────────────

function json(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(data))
}

function err(res, status, message) {
  json(res, status, { error: message })
}

async function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = ''
    let length = 0
    req.on('data', chunk => { 
      body += chunk 
      length += chunk.length
      if (length > 100 * 1024) { // 100KB Limit
        req.destroy()
        reject(new Error('Payload Too Large'))
      }
    })
    req.on('end',  ()    => {
      try { resolve(body ? JSON.parse(body) : {}) }
      catch { reject(new Error('Invalid JSON body')) }
    })
    req.on('error', reject)
  })
}

// ─── 라우터 ──────────────────────────────────────────────────────────────────

const userRunning = new Set()
const rateLimitCache = new Map()

function isRateLimited(userId) {
  const now = Date.now()
  const lastRun = rateLimitCache.get(userId)
  if (lastRun && now - lastRun < 60 * 1000) { // 1 minute limit
    return true
  }
  rateLimitCache.set(userId, now)
  return false
}

// ─── Route Handlers ────────────────────────────────────────────────────────────

async function handleHealth(req, res) {
  return json(res, 200, { status: 'ok', ts: new Date().toISOString() })
}

async function handleConfig(req, res) {
  return json(res, 200, {
    SUPABASE_URL: process.env.SUPABASE_URL ?? '',
    SUPABASE_ANON_KEY: process.env.SUPABASE_ANON_KEY ?? '',
  })
}

async function handleGetMe(req, res, url, user) {
  const settings = await getUserSettings(user.id)
  return json(res, 200, { id: user.id, email: user.email, settings })
}

async function handlePutMeSettings(req, res, url, user) {
  const body = await readBody(req)
  const updated = await updateUserSettings(user.id, body)
  return json(res, 200, { ok: true, settings: updated })
}

async function handleGetHistory(req, res, url, user) {
  const limit = parseInt(url.searchParams.get('limit') ?? '30', 10)
  const history = await getBriefingHistory(user.id, limit)
  return json(res, 200, { history })
}

async function handlePostRun(req, res, url, user) {
  if (userRunning.has(user.id)) return err(res, 409, 'Pipeline already running for your account')
  if (isRateLimited(user.id)) return err(res, 429, 'Too Many Requests. Please wait 1 minute before running again.')

  json(res, 202, { status: 'accepted', message: 'Pipeline started for your account' })

  userRunning.add(user.id)
  const settings  = await getUserSettings(user.id)
  const { settingsToOverride } = await import('./users.js')
  const override  = settingsToOverride(settings)
  if (!override.email.to) override.email.to = user.email

  runPipeline({ userId: user.id, override })
    .then(() => logger.info(`[api] Manual run done for userId=${user.id}`))
    .catch(e  => logger.error(`[api] Manual run failed: ${e.message}`))
    .finally(() => { userRunning.delete(user.id) })
}

async function handleAdminGetUsers(req, res, url, user) {
  const sb = getSupabase()
  const { data, error: e } = await sb
    .from('a_user_profiles')
    .select('*, a_user_settings(*)')
    .order('created_at', { ascending: false })
  if (e) throw e
  return json(res, 200, { users: data })
}

async function handleAdminRunAll(req, res, url, user) {
  json(res, 202, { status: 'accepted' })
  runScheduledUsers().catch(e => logger.error(`[api/admin] run-all failed: ${e.message}`))
}

// ─── 라우팅 테이블 ─────────────────────────────────────────────────────────────

const publicRoutes = {
  'GET /api/health': handleHealth,
  'GET /api/config': handleConfig
}

const authRoutes = {
  'GET /api/me': handleGetMe,
  'PUT /api/me/settings': handlePutMeSettings,
  'GET /api/history': handleGetHistory,
  'POST /api/run': handlePostRun
}

const adminRoutes = {
  'GET /api/admin/users': handleAdminGetUsers,
  'POST /api/admin/run-all': handleAdminRunAll
}

async function handleGetFeed(req, res, url) {
  const match = url.pathname.match(/^\/api\/feed\/([a-f0-9-]+)\.xml$/)
  if (!match) return err(res, 404, 'Not found')
  const userId = match[1]

  try {
    const history = await getBriefingHistory(userId, 10)
    const baseUrl = `https://${req.headers.host}`
    
    // RSS XML 구성
    let xml = `<?xml version="1.0" encoding="UTF-8"?>\n`
    xml += `<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd">\n`
    xml += `<channel>\n`
    xml += `  <title>Morning Briefing for ${userId.slice(0,8)}</title>\n`
    xml += `  <link>${baseUrl}</link>\n`
    xml += `  <description>Your personalized morning news briefing.</description>\n`
    xml += `  <language>en-us</language>\n`

    for (const log of history) {
      if (!log.audio_url) continue
      
      const pubDate = new Date(log.created_at).toUTCString()
      // 임시로 uuid와 날짜 조합을 guid로 사용
      const guid = `${userId}-${log.id}`
      
      xml += `  <item>\n`
      xml += `    <title>Briefing - ${log.date}</title>\n`
      xml += `    <description><![CDATA[${log.script}]]></description>\n`
      xml += `    <pubDate>${pubDate}</pubDate>\n`
      xml += `    <enclosure url="${log.audio_url}" type="audio/mpeg"/>\n`
      xml += `    <guid isPermaLink="false">${guid}</guid>\n`
      xml += `    <itunes:duration>${Math.round(log.duration_ms / 1000)}</itunes:duration>\n`
      xml += `  </item>\n`
    }

    xml += `</channel>\n</rss>`

    res.writeHead(200, { 'Content-Type': 'application/rss+xml' })
    res.end(xml)
  } catch (e) {
    logger.error(`[api/feed] Failed to generate RSS: ${e.message}`)
    return err(res, 500, 'Failed to generate feed')
  }
}

export async function handleApiRequest(req, res) {
  const url    = new URL(req.url, 'http://localhost')
  const path   = url.pathname
  const method = req.method
  const routeKey = `${method} ${path}`

  try {
    if (publicRoutes[routeKey]) {
      return await publicRoutes[routeKey](req, res, url)
    }

    // Phase 4: RSS Feed Route (Public, but requires user ID in URL)
    if (method === 'GET' && path.startsWith('/api/feed/')) {
      return await handleGetFeed(req, res, url)
    }

    const user = await verifyToken(req)
    if (!user) return err(res, 401, 'Unauthorized')

    if (authRoutes[routeKey]) {
      return await authRoutes[routeKey](req, res, url, user)
    }

    if (adminRoutes[routeKey]) {
      if (!isAdmin(user)) return err(res, 403, 'Forbidden')
      return await adminRoutes[routeKey](req, res, url, user)
    }

    return err(res, 404, 'Not found')

  } catch (e) {
    if (e.message === 'Payload Too Large') return err(res, 413, e.message)
    logger.error(`[api] Unhandled error: ${e.message}`)
    return err(res, 500, e.message)
  }
}
