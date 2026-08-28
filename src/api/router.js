// src/api/router.js
// 공개 전용 REST 라우터 (Express 없이 Node http 모듈 기반, src/index.js에서 마운트).
//
// 2026-08 정리: 설정 변경·수동실행·관리자 기능과 그에 딸린 Supabase Auth를 전부 걷어냈다.
// 이유 — 설정은 클로드코드/맥미니 대시보드(99_open-board)에서 관리하는 것으로 일원화했고,
// 이 배포본에 남은 목적은 "RSS 팟캐스트 피드 + 지난 방송 듣기" 하나뿐이다.
// 인증이 사라져 공개 표면은 읽기 전용 3개로 줄었다.
//
// 엔드포인트:
//   GET /api/meta                 → 피드 주소 등 페이지 렌더링용 메타
//   GET /api/history              → 최근 30일 방송 목록 (공개)
//   GET /api/feed/<userId>.xml    → 팟캐스트 RSS (기존 구독 URL 유지)

import { getBriefingHistory } from './users.js'
import { getSupabase }        from './supabase.js'
import { logger }             from '../utils/logger.js'

// 피드·히스토리에 싣는 회차 수. 팟캐스트 앱은 피드에 실린 것만 보여주므로
// 페이지의 히스토리와 같은 값을 써서 "보이는 것 = 구독으로 받는 것"을 일치시킨다.
const EPISODE_LIMIT = 30

// ─── 응답 헬퍼 ───────────────────────────────────────────────────────────────

function json(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(data))
}

function err(res, status, message) {
  json(res, status, { error: message })
}

/** XML 특수문자 이스케이프 (RSS 텍스트 노드용) */
function escapeXml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

// ─── 대상 사용자 해석 ────────────────────────────────────────────────────────
//
// 1인 운영이라 UUID를 어디에도 하드코딩하지 않고 DB에서 활성 사용자를 찾아 캐시한다.
// (설정 UI가 사라진 뒤로 이 값이 런타임에 바뀔 일이 없어 프로세스 수명 동안 캐시해도 안전)

let _activeUserId = null

async function getActiveUserId() {
  if (_activeUserId) return _activeUserId
  const sb = getSupabase()
  const { data, error } = await sb
    .from('a_user_settings')
    .select('user_id, a_user_profiles!inner(is_active)')
    .eq('schedule_enabled', true)
    .eq('a_user_profiles.is_active', true)
    .limit(1)
    .maybeSingle()

  if (error) throw new Error(`getActiveUserId failed: ${error.message}`)
  if (!data) throw new Error('No active user configured')
  _activeUserId = data.user_id
  return _activeUserId
}

// ─── 핸들러 ──────────────────────────────────────────────────────────────────

async function handleHealth(req, res) {
  return json(res, 200, { status: 'ok', ts: new Date().toISOString() })
}

async function handleMeta(req, res) {
  const userId = await getActiveUserId()
  return json(res, 200, {
    feedPath: `/api/feed/${userId}.xml`,
    episodeLimit: EPISODE_LIMIT,
  })
}

async function handleHistory(req, res) {
  const userId  = await getActiveUserId()
  const history = await getBriefingHistory(userId, EPISODE_LIMIT)
  // 공개 페이지이므로 내부 정보(llm_provider/tts_provider)는 싣지 않는다.
  const items = history
    .filter(log => log.audio_url)
    .map(log => ({
      date:       log.date,
      script:     log.script,
      audioUrl:   log.audio_url,
      durationMs: log.duration_ms,
    }))
  return json(res, 200, { items })
}

async function handleFeed(req, res, url) {
  const match = url.pathname.match(/^\/api\/feed\/([a-f0-9-]+)\.xml$/)
  if (!match) return err(res, 404, 'Not found')
  const userId = match[1]

  try {
    const history = await getBriefingHistory(userId, EPISODE_LIMIT)
    const baseUrl = `https://${req.headers.host}`

    // 오디오 URL은 업로드 시점에 영구 공개 URL로 저장된다(storage.js).
    // 예전엔 7일 서명 URL이라 피드가 매 요청마다 전 회차를 재서명해야 했는데,
    // 버킷이 애초에 public이라 불필요한 왕복이었다.
    let xml = `<?xml version="1.0" encoding="UTF-8"?>\n`
    xml += `<rss version="2.0" \n`
    xml += `     xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd"\n`
    xml += `     xmlns:content="http://purl.org/rss/1.0/modules/content/">\n`
    xml += `<channel>\n`
    xml += `  <title>☀️ Morning Briefing</title>\n`
    xml += `  <link>${baseUrl}</link>\n`
    xml += `  <language>en</language>\n`
    xml += `  <itunes:author>AI Anchor</itunes:author>\n`
    xml += `  <itunes:summary>매일 아침 AI 앵커가 전달하는 맞춤형 개인화 종합 뉴스 브리핑쇼입니다.</itunes:summary>\n`
    xml += `  <description>매일 아침 AI 앵커가 전달하는 맞춤형 개인화 종합 뉴스 브리핑쇼입니다.</description>\n`
    xml += `  <itunes:image href="${baseUrl}/a_thumbnail.png"/>\n`
    xml += `  <itunes:category text="Technology"/>\n`
    xml += `  <itunes:category text="News"/>\n`
    xml += `  <itunes:explicit>no</itunes:explicit>\n`

    for (const log of history) {
      if (!log.audio_url) continue

      const pubDate = new Date(log.created_at).toUTCString()
      const guid = `briefing-${userId}-${log.id}`
      const cleanSummary = log.script.replace(/\[PAUSE\]/ig, ' ').slice(0, 250) + '...'

      xml += `  <item>\n`
      xml += `    <title>☀️ AI Briefing - ${escapeXml(log.date)}</title>\n`
      xml += `    <itunes:author>AI Anchor</itunes:author>\n`
      xml += `    <itunes:summary>${escapeXml(cleanSummary)}</itunes:summary>\n`
      xml += `    <description><![CDATA[${log.script.replace(/\]\]>/g, ']]&gt;').replace(/\n/g, '<br/>')}]]></description>\n`
      xml += `    <pubDate>${pubDate}</pubDate>\n`
      xml += `    <enclosure url="${escapeXml(log.audio_url)}" length="0" type="audio/mpeg"/>\n`
      xml += `    <guid isPermaLink="false">${guid}</guid>\n`
      xml += `    <itunes:duration>${Math.round(log.duration_ms / 1000)}</itunes:duration>\n`
      xml += `    <itunes:explicit>no</itunes:explicit>\n`
      xml += `  </item>\n`
    }

    xml += `</channel>\n</rss>`

    res.writeHead(200, { 'Content-Type': 'application/rss+xml; charset=utf-8' })
    res.end(xml)
  } catch (e) {
    logger.error(`[api/feed] Failed to generate RSS: ${e.message}`)
    return err(res, 500, 'Failed to generate feed')
  }
}

// ─── 라우팅 ──────────────────────────────────────────────────────────────────

const routes = {
  'GET /api/health':  handleHealth,
  'GET /api/meta':    handleMeta,
  'GET /api/history': handleHistory,
}

export async function handleApiRequest(req, res) {
  const url    = new URL(req.url, 'http://localhost')
  const path   = url.pathname
  const method = req.method

  try {
    const handler = routes[`${method} ${path}`]
    if (handler) return await handler(req, res, url)

    if (method === 'GET' && path.startsWith('/api/feed/')) {
      return await handleFeed(req, res, url)
    }

    return err(res, 404, 'Not found')
  } catch (e) {
    logger.error(`[api] Unhandled error: ${e.message}`)
    return err(res, 500, e.message)
  }
}
