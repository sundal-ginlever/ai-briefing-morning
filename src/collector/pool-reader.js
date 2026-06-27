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
 * Supabase PostgREST의 `not in` 필터용 값 목록을 안전하게 포맷.
 * 배열을 그대로 넘기면 괄호 없이 직렬화돼 필터가 동작하지 않거나,
 * URL 내 쉼표/괄호 때문에 깨질 수 있으므로 ("v1","v2") 형태로 감싼다.
 */
function toInList(values) {
  return `(${values.map(v => `"${String(v).replace(/"/g, '')}"`).join(',')})`
}

/** 기사 제목+설명에서 매칭되는 키워드 목록 반환 (대소문자 무시) */
function matchedKeywords(article, keywords) {
  const text = `${article.title || ''} ${article.description || ''}`.toLowerCase()
  return keywords.filter(k => text.includes(String(k).toLowerCase()))
}

/**
 * news pool에서 최근 24시간 기사를 가져옴. (사용자별로 읽은 기사 제외)
 * 반환: { articles, report }  ← report는 선정 검증 리포트용 메타데이터
 */
export async function fetchArticlesFromPool(userId, keywords = [], limit = 5, override = {}) {
  const sb = await getClient()
  if (!sb) throw new Error('Supabase not configured')

  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
  const safeKeywords = keywords || []
  let finalArticles = []

  // 검증 리포트용 메타데이터 (선정 로직에는 영향 없음)
  const report = {
    keywords:             safeKeywords,
    poolTotal:            0,
    keywordDistribution:  {},
    excludedDuplicates:   0,
    stage1Count:          0,
    stage2Count:          0,
    stage2CandidateCount: 0,
    stage2Method:         'none',   // 'ai' | 'slice' | 'none'
    selected:             [],
  }

  // 0) 사용자가 과거 7일간 읽은 기사 URL 목록 추출 (중복 방지)
  let usedUrls = []
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
          for (const a of row.articles) {
            if (a.url) usedUrls.push(a.url)
          }
        }
      }
    }
  }
  report.excludedDuplicates = usedUrls.length

  // 리포트용: 24h pool 분포 통계 (가벼운 필드만, 선정에는 미사용)
  try {
    const { data: poolAll } = await sb
      .from('a_news_pool')
      .select('title, description')
      .gte('collected_at', since)
    report.poolTotal = poolAll?.length ?? 0
    for (const k of safeKeywords) {
      report.keywordDistribution[k] = (poolAll || []).filter(a =>
        `${a.title || ''} ${a.description || ''}`.toLowerCase().includes(String(k).toLowerCase())
      ).length
    }
  } catch (e) {
    logger.warn(`[pool-reader] pool stats failed: ${e.message}`)
  }

  // 1) 키워드가 있을 경우 키워드 매칭 기사 먼저 검색 (우선순위 1단계)
  if (safeKeywords.length > 0) {
    const orConditions = safeKeywords.flatMap(k => [
      `title.ilike.%${k}%`,
      `description.ilike.%${k}%`
    ]).join(',')

    let query = sb
      .from('a_news_pool')
      .select('title, description, source_name, url, published_at')
      .gte('collected_at', since)
      .or(orConditions)
      .order('published_at', { ascending: false })
      .limit(limit)

    if (usedUrls.length > 0) {
      query = query.not('url', 'in', toInList(usedUrls))
    }

    const { data: kwData, error: kwError } = await query

    if (kwError) logger.warn(`[pool-reader] Keyword search failed: ${kwError.message}`)
    else finalArticles = kwData || []
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

  // 2) 기사가 부족하면 AI 기반의 최정예 핫이슈 뉴스로 채움 (우선순위 2단계 - AI 필터)
  if (finalArticles.length < limit) {
    const remaining = limit - finalArticles.length
    const excludeUrls = finalArticles.map(a => a.url)
    const allExclude = [...usedUrls, ...excludeUrls]

    // 인기도 엄선을 위해 5배수(기본 25개)의 최신 기사 후보군을 넉넉히 가져옵니다
    const candidateLimit = 25
    let query = sb
      .from('a_news_pool')
      .select('title, description, source_name, url, published_at')
      .gte('collected_at', since)
      .order('published_at', { ascending: false })
      .limit(candidateLimit)

    if (allExclude.length > 0) {
      query = query.not('url', 'in', toInList(allExclude))
    }

    const { data: candidates, error: genError } = await query
    if (genError) {
      logger.warn(`[pool-reader] Fallback candidate search failed: ${genError.message}`)
    } else if (candidates && candidates.length > 0) {
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
        const hotArticles = await filterTopArticles(normalizedCandidates, remaining, override)
        picked = hotArticles.map(a => ({
          title:        a.title,
          description:  a.description,
          source_name:  a.source,
          url:          a.url,
          published_at: a.publishedAt,
        }))
        report.stage2Method = 'ai'
      } catch (err) {
        logger.warn(`[pool-reader] AI Curation failed: ${err.message}. Falling back to standard slicing.`)
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
