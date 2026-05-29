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
export async function fetchArticlesFromPool(userId, keywords = [], limit = 5, override = {}) {
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
      query = query.not('url', 'in', usedUrls)
    }

    const { data: kwData, error: kwError } = await query

    if (kwError) logger.warn(`[pool-reader] Keyword search failed: ${kwError.message}`)
    else finalArticles = kwData || []
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
      query = query.not('url', 'in', allExclude)
    }

    const { data: candidates, error: genError } = await query
    if (genError) {
      logger.warn(`[pool-reader] Fallback candidate search failed: ${genError.message}`)
    } else if (candidates && candidates.length > 0) {
      logger.info(`[pool-reader] Fetched ${candidates.length} candidates. Selecting top ${remaining} via AI...`)
      
      const normalizedCandidates = candidates.map(a => ({
        title:       a.title,
        description: a.description || '',
        source:      a.source_name,
        url:         a.url,
        publishedAt: a.published_at,
      }))

      try {
        const { filterTopArticles } = await import('../providers/llm.js')
        const hotArticles = await filterTopArticles(normalizedCandidates, remaining, override)
        
        finalArticles.push(...hotArticles.map(a => ({
          title:       a.title,
          description: a.description,
          source_name: a.source,
          url:         a.url,
          published_at: a.publishedAt,
        })))
      } catch (err) {
        logger.warn(`[pool-reader] AI Curation failed: ${err.message}. Falling back to standard slicing.`)
        finalArticles.push(...candidates.slice(0, remaining))
      }
    }
  }

  logger.info(`[pool-reader] Total ${finalArticles.length} articles selected (Keywords matched: ${finalArticles.length - (limit - safeKeywords.length)})`)

  return finalArticles.map(a => ({
    title:       a.title,
    description: a.description || '',
    source:      a.source_name,
    url:         a.url,
    publishedAt: a.published_at || a.published_at,
  }))
}

/**
 * 브리핑에 사용된 기사를 마킹. (더 이상 전역 플래그를 사용하지 않으므로 빈 함수 유지)
 */
export async function markArticlesAsUsed(urls) {
  // Phase 7: 로그 테이블(a_briefing_logs)을 통해 중복을 방지하므로 아무 작업도 하지 않음
  logger.info(`[pool-reader] markArticlesAsUsed disabled (moved to user-specific logging)`)
}
