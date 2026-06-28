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

/**
 * news pool에서 최근 24시간 기사를 가져와 선정.
 *  - 키워드 매칭: 단어경계 기준 (부분문자열 오매칭 방지)
 *  - 우선순위/다양성: 키워드 입력 순서대로 라운드로빈 (각 키워드 1개씩 번갈아)
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

  // 2) 키워드별 라운드로빈 선정 (입력 순서 = 우선순위, 각 키워드 1개씩 번갈아)
  const selectedUrls = new Set()
  let finalArticles = []

  if (safeKeywords.length > 0) {
    const buckets = safeKeywords.map(kw => ({
      kw,
      articles: pool.filter(a => wordBoundaryMatch(`${a.title || ''} ${a.description || ''}`, kw)),
    }))

    let progressed = true
    while (finalArticles.length < limit && progressed) {
      progressed = false
      for (const bucket of buckets) {
        if (finalArticles.length >= limit) break
        const next = bucket.articles.find(a => !selectedUrls.has(a.url))
        if (next) {
          selectedUrls.add(next.url)
          finalArticles.push(next)
          progressed = true
        }
      }
    }
  }

  report.stage1Count = finalArticles.length
  for (const a of finalArticles) {
    report.selected.push({
      title:      a.title,
      url:        a.url,
      source:     a.source_name,
      selectedBy: 'keyword',
      matched:    matchedKeywords(a, safeKeywords),
    })
  }

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
