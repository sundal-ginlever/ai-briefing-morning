// src/collector/pool-reader.js
import { config } from '../../config/index.js'
import { logger } from '../utils/logger.js'

async function getClient() {
  if (!config.supabase.url || !config.supabase.serviceKey) return null
  const { createClient } = await import('@supabase/supabase-js')
  return createClient(config.supabase.url, config.supabase.serviceKey, {
    auth: { persistSession: false },
  })
}

/**
 * 단어 경계(\b) 기준 매칭. 대소문자 무시.
 * 'AI'가 'brain'/'Cain'/'again' 등에 부분 매칭되던 문제를 방지한다.
 */
function wordBoundaryMatch(text, keyword) {
  const esc = String(keyword).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`\\b${esc}\\b`, 'i').test(text)
}

/** 기사(제목+설명)에서 단어경계로 매칭되는 키워드 목록 */
function matchedKeywords(article, keywords) {
  const text = `${article.title || ''} ${article.description || ''}`
  return keywords.filter(k => wordBoundaryMatch(text, k))
}

/** Fisher-Yates 셔플 (원본 배열 불변) */
function shuffle(arr) {
  const a = [...arr]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

/**
 * 고정 5슬롯 편성표. 매일 이 구성대로 기사를 채운다.
 *  - fixed    : 후보 1개, 그대로 사용
 *  - random   : 후보 중 매 생성마다 무작위 순서로 시도(첫 매칭 채택) — 같은 슬롯이라도
 *               고른 후보에 기사가 없으면 같은 주제군 안에서 다음 후보로 자연스럽게 대체됨
 *  - priority : 후보를 나열 순서대로 시도 — 1순위가 없을 때만 2순위로 폴백
 * 슬롯이 전부 실패하면(모든 후보 매칭 0) 그 자리는 비워두고 3단계 AI 큐레이션이 채운다.
 */
const SLOTS = [
  { name: 'AI',       type: 'fixed',    candidates: ['AI'] },
  { name: 'crypto',   type: 'random',   candidates: ['bitcoin', 'ethereum', 'Bitmine'] },
  { name: 'defi',     type: 'random',   candidates: ['DeFi', 'TVL'] },
  { name: 'palantir', type: 'fixed',    candidates: ['palantir'] },
  { name: 'defense',  type: 'priority', candidates: ['erebor', 'Anduril'] },
]

/**
 * news pool에서 최근 24시간 기사를 가져와 선정.
 *  - 키워드 매칭: 단어경계 기준 (부분문자열 오매칭 방지)
 *  - 편성: 고정 5슬롯(SLOTS) — 슬롯별 규칙(고정/랜덤/우선순위)대로 후보를 골라 매칭
 *  - 부족분: AI 큐레이션 폴백
 * 반환: { articles, report }
 */
export async function fetchArticlesFromPool(userId, keywords = [], limit = 5, override = {}) {
  const sb = await getClient()
  if (!sb) throw new Error('Supabase not configured')

  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
  const safeKeywords = (keywords || []).filter(Boolean)

  const report = {
    keywords:             safeKeywords,
    poolTotal:            0,
    keywordDistribution:  {},
    excludedDuplicates:   0,
    stage1Count:          0,
    stage2Count:          0,
    stage2CandidateCount: 0,
    stage2Method:         'none',
    selected:             [],
  }

  // 0) 7일간 읽은 기사 URL (중복 방지)
  const usedSet = new Set()
  if (userId) {
    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()
    const { data: logsData } = await sb
      .from('a_briefing_logs')
      .select('articles')
      .eq('user_id', userId)
      .gte('created_at', weekAgo)
    if (logsData) {
      for (const row of logsData) {
        if (Array.isArray(row.articles)) {
          for (const a of row.articles) { if (a.url) usedSet.add(a.url) }
        }
      }
    }
  }
  report.excludedDuplicates = usedSet.size

  // 1) 24h pool 전체를 한 번 가져와 메모리에서 선정 (단어경계/라운드로빈을 위해)
  const { data: rawPool, error: poolErr } = await sb
    .from('a_news_pool')
    .select('title, description, source_name, url, published_at')
    .gte('collected_at', since)
    .order('published_at', { ascending: false })
    .limit(1000)

  if (poolErr) throw new Error(`pool fetch failed: ${poolErr.message}`)

  const pool = (rawPool || []).filter(a => a.url && !usedSet.has(a.url))
  report.poolTotal = (rawPool || []).length

  // 키워드별 분포 (단어경계 기준)
  for (const k of safeKeywords) {
    report.keywordDistribution[k] = pool.filter(a =>
      wordBoundaryMatch(`${a.title || ''} ${a.description || ''}`, k)
    ).length
  }

  // 2) 슬롯 편성 — 슬롯마다 규칙(고정/랜덤/우선순위)대로 후보 키워드를 시도해
  //    가장 최신 미사용 기사를 채운다. pool은 이미 published_at 내림차순이라
  //    bucket.find()의 첫 매칭이 곧 최신 기사.
  const selectedUrls = new Set()
  let finalArticles = []

  for (const slot of SLOTS) {
    if (finalArticles.length >= limit) break

    const order = slot.type === 'random' ? shuffle(slot.candidates) : slot.candidates
    let picked = null, pickedKw = null
    for (const kw of order) {
      const match = pool.find(a =>
        !selectedUrls.has(a.url) && wordBoundaryMatch(`${a.title || ''} ${a.description || ''}`, kw)
      )
      if (match) { picked = match; pickedKw = kw; break }
    }

    if (picked) {
      selectedUrls.add(picked.url)
      finalArticles.push(picked)
      report.selected.push({
        title:       picked.title,
        url:         picked.url,
        source:      picked.source_name,
        selectedBy:  `slot:${slot.name}`,
        slotKeyword: pickedKw,
        matched:     matchedKeywords(picked, safeKeywords),
      })
    } else {
      logger.info(`[pool-reader] slot "${slot.name}" 후보 전부 매칭 실패(${slot.candidates.join('/')}) — AI 큐레이션으로 대체 예정`)
    }
  }

  report.stage1Count = finalArticles.length

  // 3) 부족분 AI 큐레이션 (최신 후보 25개 중 선별)
  if (finalArticles.length < limit) {
    const remaining = limit - finalArticles.length
    const candidates = pool.filter(a => !selectedUrls.has(a.url)).slice(0, 25)

    if (candidates.length > 0) {
      report.stage2CandidateCount = candidates.length
      logger.info(`[pool-reader] Fetched ${candidates.length} candidates. Selecting top ${remaining} via AI...`)

      const normalizedCandidates = candidates.map(a => ({
        title:       a.title,
        description: a.description || '',
        source:      a.source_name,
        url:         a.url,
        publishedAt: a.published_at,
      }))

      let picked = []
      try {
        const { filterTopArticles } = await import('../providers/llm.js')
        const hot = await filterTopArticles(normalizedCandidates, remaining, override)
        picked = hot.map(a => ({
          title:        a.title,
          description:  a.description,
          source_name:  a.source,
          url:          a.url,
          published_at: a.publishedAt,
        }))
        report.stage2Method = 'ai'
      } catch (err) {
        logger.warn(`[pool-reader] AI Curation failed: ${err.message}. Falling back to slicing.`)
        picked = candidates.slice(0, remaining)
        report.stage2Method = 'slice'
      }

      finalArticles.push(...picked)
      report.stage2Count = picked.length
      for (const a of picked) {
        report.selected.push({
          title:      a.title,
          url:        a.url,
          source:     a.source_name,
          selectedBy: report.stage2Method === 'ai' ? 'ai-curation' : 'ai-slice',
          matched:    matchedKeywords(a, safeKeywords),
        })
      }
    }
  }

  logger.info(`[pool-reader] Selected ${finalArticles.length} (keyword=${report.stage1Count}, ai=${report.stage2Count}) | pool24h=${report.poolTotal}, excludedDup=${report.excludedDuplicates}`)

  const articles = finalArticles.map(a => ({
    title:       a.title,
    description: a.description || '',
    source:      a.source_name,
    url:         a.url,
    publishedAt: a.published_at || null,
  }))

  return { articles, report }
}
