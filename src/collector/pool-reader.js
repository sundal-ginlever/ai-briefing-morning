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
 * news pool에서 최근 24시간 기사를 가져옴.
 */
export async function fetchArticlesFromPool(keywords = [], limit = 5) {
  const sb = await getClient()
  if (!sb) throw new Error('Supabase not configured')

  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
  let finalArticles = []

  // 1) 키워드가 있을 경우 키워드 매칭 기사 먼저 검색
  if (keywords.length > 0) {
    const orConditions = keywords.flatMap(k => [
      `title.ilike.%${k}%`,
      `description.ilike.%${k}%`
    ]).join(',')

    const { data: kwData, error: kwError } = await sb
      .from('a_news_pool')
      .select('title, description, source_name, url, published_at')
      .eq('used_in_briefing', false)
      .gte('collected_at', since)
      .or(orConditions)
      .order('published_at', { ascending: false })
      .limit(limit)

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
      .eq('used_in_briefing', false)
      .gte('collected_at', since)
      .order('published_at', { ascending: false })
      .limit(remaining)

    if (excludeUrls.length > 0) {
      query = query.not('url', 'in', `(${excludeUrls.join(',')})`)
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
 * 브리핑에 사용된 기사를 마킹.
 */
export async function markArticlesAsUsed(urls) {
  const sb = await getClient()
  if (!sb) return

  const { error } = await sb
    .from('a_news_pool')
    .update({ used_in_briefing: true })
    .in('url', urls)

  if (error) {
    logger.warn(`[pool-reader] Failed to mark articles: ${error.message}`)
  } else {
    logger.info(`[pool-reader] Marked ${urls.length} articles as used`)
  }
}
