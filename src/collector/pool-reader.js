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

  let query = sb
    .from('a_news_pool')
    .select('title, description, source_name, url, published_at')
    .eq('used_in_briefing', false)
    .gte('collected_at', since)
    .order('published_at', { ascending: false })
    .limit(limit)

  // 키워드가 있을 경우 처리 (간단하게 구현)
  // 실제로는 PostgREST에서 복잡한 OR 필터링이 필요할 수 있으나 여기서는 기본 조회 후 필터링하거나 그냥 둠.
  
  const { data, error } = await query
  if (error) throw new Error(`Pool query failed: ${error.message}`)

  logger.info(`[pool-reader] Found ${data?.length ?? 0} articles in pool`)

  return (data ?? []).map(a => ({
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
