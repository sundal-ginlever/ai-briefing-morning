// src/collector/collect.js
import { config } from '../../config/index.js'
import { logger } from '../utils/logger.js'
import { collectFromNewsAPI } from './sources/newsapi.js'
import { collectFromRSS } from './sources/rss.js'
import { deduplicateArticles } from './dedup.js'

async function getSupabaseClient() {
  if (!config.supabase.url || !config.supabase.serviceKey) return null
  const { createClient } = await import('@supabase/supabase-js')
  return createClient(config.supabase.url, config.supabase.serviceKey, {
    auth: { persistSession: false },
  })
}

async function main() {
  const startTime = Date.now()
  logger.info('[collector] Starting news collection...')

  // NewsAPI는 하루 한도(100회) 방어를 위해 짝수 시간(UTC)에만 수집
  const currentHour = new Date().getUTCHours()
  const shouldRunNewsAPI = currentHour % 2 === 0
  
  const tasks = [ collectFromRSS() ]
  if (shouldRunNewsAPI) {
    tasks.push(
      collectFromNewsAPI(config.news.apiKey, {
        country: config.news.country,
        categories: config.news.categories,
        pageSize: 10,
      })
    )
  } else {
    logger.info('[collector] Skipping NewsAPI on odd hours to conserve rate limits')
  }

  // 1) 모든 소스에서 병렬 수집
  const results = await Promise.allSettled(tasks)

  // 2) 결과 합산
  const allArticles = []
  results.forEach((r, i) => {
    const sourceName = shouldRunNewsAPI ? (i === 0 ? 'RSS' : 'NewsAPI') : 'RSS'
    if (r.status === 'fulfilled') {
      logger.info(`[collector] ${sourceName}: ${r.value.length} articles`)
      allArticles.push(...r.value)
    } else {
      logger.warn(`[collector] ${sourceName} failed: ${r.reason?.message}`)
    }
  })

  // 3) 중복 제거
  const unique = deduplicateArticles(allArticles)
  logger.info(`[collector] ${unique.length} unique articles after dedup`)

  if (unique.length === 0) {
    logger.info('[collector] No articles to save. Done.')
    return
  }

  // 4) Supabase에 UPSERT
  const sb = await getSupabaseClient()
  if (!sb) {
    logger.warn('[collector] Supabase not configured, skipping save.')
    return
  }

  const rows = unique.map(a => ({
    title:        a.title,
    description:  a.description || '',
    source_name:  a.source_name,
    source_type:  a.source_type,
    url:          a.url,
    published_at: a.published_at || new Date().toISOString(),
    categories:   a.categories || [],
    keywords:     a.keywords || [],
    language:     'en',
  }))

  const { error } = await sb
    .from('a_news_pool')
    .upsert(rows, { onConflict: 'url', ignoreDuplicates: true })

  if (error) {
    logger.error(`[collector] DB upsert failed: ${error.message}`)
  } else {
    logger.info(`[collector] Saved to a_news_pool`)
  }

  // 5) 7일 이상 된 기사 정리
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()
  const { error: cleanupErr } = await sb
    .from('a_news_pool')
    .delete()
    .lt('collected_at', sevenDaysAgo)

  if (cleanupErr) {
    logger.warn(`[collector] Cleanup failed: ${cleanupErr.message}`)
  } else {
    logger.info(`[collector] Cleaned up articles older than 7 days`)
  }

  const duration = ((Date.now() - startTime) / 1000).toFixed(1)
  logger.info(`[collector] Done in ${duration}s`)
}

main().catch(err => {
  logger.error(`[collector] FATAL: ${err.message}`)
  process.exit(1)
})
