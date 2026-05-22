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
 * news pool에서 최근 24시간 기사를 가져옴. (사용자별로 읽은 기사 제외)
 */
export async function fetchArticlesFromPool(userId, keywords = [], limit = 5) {
  const sb = await getClient()
  if (!sb) throw new Error('Supabase not configured')

  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
  let finalArticles = []

  const safeKeywords = keywords || []

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

  // 1) 키워드가 있을 경우 키워드 매칭 기사 먼저 검색
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
      query = query.not('url', 'in', usedUrls)
    }

    const { data: kwData, error: kwError } = await query

    if (kwError) logger.warn(`[pool-reader] Keyword search failed: ${kwError.message}`)
    else finalArticles = kwData || []
  }

  // 2) 기사가 부족하면 최신 기사로 채움 (폴백)
  if (finalArticles.length < limit) {
    const remaining = limit - finalArticles.length
    const excludeUrls = finalArticles.map(a => a.url)

    let query = sb
      .from('a_news_pool')
      .select('title, description, source_name, url, published_at')
      .gte('collected_at', since)
      .order('published_at', { ascending: false })
      .limit(remaining)

    const allExclude = [...usedUrls, ...excludeUrls]
    if (allExclude.length > 0) {
      query = query.not('url', 'in', allExclude)
    }

    const { data: genData, error: genError } = await query
    if (genError) logger.warn(`[pool-reader] Fallback search failed: ${genError.message}`)
    else finalArticles.push(...(genData || []))
  }

  logger.info(`[pool-reader] Found ${finalArticles.length} articles (Keywords: ${keywords.length > 0})`)

  return finalArticles.map(a => ({
    title:       a.title,
    description: a.description || '',
    source:      a.source_name,
    url:         a.url,
    publishedAt: a.published_at,
  }))
}

/**
 * 브리핑에 사용된 기사를 마킹. (더 이상 전역 플래그를 사용하지 않으므로 빈 함수 유지)
 */
export async function markArticlesAsUsed(urls) {
  // Phase 7: 로그 테이블(a_briefing_logs)을 통해 중복을 방지하므로 아무 작업도 하지 않음
  logger.info(`[pool-reader] markArticlesAsUsed disabled (moved to user-specific logging)`)
}
