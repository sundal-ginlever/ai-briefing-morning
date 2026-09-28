// src/collector/collect.js
import { config } from '../../config/index.js'
import { logger } from '../utils/logger.js'
import { collectFromNewsAPI } from './sources/newsapi.js'
import { collectFromRSS, collectFromGoogleNewsKeywords } from './sources/rss.js'
import { deduplicateArticles } from './dedup.js'

// NewsAPI top-headlines가 허용하는 유효 카테고리 (그 외 값은 무시)
const VALID_CATEGORIES = ['business', 'entertainment', 'general', 'health', 'science', 'sports', 'technology']

async function getSupabaseClient() {
  if (!config.supabase.url || !config.supabase.serviceKey) return null
  const { createClient } = await import('@supabase/supabase-js')
  return createClient(config.supabase.url, config.supabase.serviceKey, {
    auth: { persistSession: false },
  })
}

const PAGE = 1000   // PostgREST 기본 최대 행 수
const CHUNK = 200   // .in() 필터 URL 길이 한도를 넉넉히 피하는 크기

/** 쿼리를 PAGE 단위로 끝까지 읽어 id 배열로 반환 */
async function fetchAllIds(build, column) {
  const ids = []
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await build().range(from, from + PAGE - 1)
    if (error) throw new Error(error.message)
    ids.push(...data.map(r => r[column]))
    if (data.length < PAGE) return ids
  }
}

/**
 * 7일 지난 풀 기사를 지우되, 카드뉴스(26_card-news) 버킷이 참조 중인 행은 남긴다.
 * cn_cardnews_bucket.news_pool_id가 이 테이블을 외래키로 물고 있어서, 조건 없이
 * 일괄 삭제하면 참조 행 하나 때문에 삭제 전체가 거부됐다(8/13부터 한 번도 정리 안 됨).
 */
async function pruneOldPool(sb) {
  const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()

  const pinned = new Set(await fetchAllIds(
    () => sb.from('cn_cardnews_bucket').select('news_pool_id').order('id'), 'news_pool_id'))
  const old = await fetchAllIds(
    () => sb.from('a_news_pool').select('id').lt('collected_at', cutoff).order('id'), 'id')
  const targets = old.filter(id => !pinned.has(id))

  for (let i = 0; i < targets.length; i += CHUNK) {
    const { error } = await sb.from('a_news_pool').delete().in('id', targets.slice(i, i + CHUNK))
    if (error) throw new Error(error.message)
  }
  return targets.length
}

/**
 * 스케줄 활성 유저들의 키워드/카테고리를 모아(union) 수집 대상으로 사용.
 * 유저 설정이 없거나 조회 실패 시 config(워크플로 env) 폴백.
 */
async function getActiveUserPrefs(sb) {
  if (!sb) return { keywords: [], categories: config.news.categories }
  const { data, error } = await sb
    .from('a_user_settings')
    .select('news_keywords, news_categories')
    .eq('schedule_enabled', true)

  if (error || !data) {
    logger.warn(`[collector] Failed to load user prefs: ${error?.message}`)
    return { keywords: [], categories: config.news.categories }
  }

  const kw = new Set(), cat = new Set()
  for (const row of data) {
    for (const k of (row.news_keywords || [])) { if (k && k.trim()) kw.add(k.trim()) }
    for (const c of (row.news_categories || [])) {
      const cc = c.trim().toLowerCase()
      if (VALID_CATEGORIES.includes(cc)) cat.add(cc)
    }
  }
  return {
    keywords:   [...kw],
    categories: cat.size > 0 ? [...cat] : config.news.categories,
  }
}

async function main() {
  const startTime = Date.now()
  logger.info('[collector] Starting news collection...')

  const sb = await getSupabaseClient()
  const prefs = await getActiveUserPrefs(sb)
  logger.info(`[collector] Active prefs — categories=[${prefs.categories}] keywords=[${prefs.keywords}]`)

  // NewsAPI는 하루 한도(100회) 방어를 위해 짝수 시간(UTC)에만 수집
  const currentHour = new Date().getUTCHours()
  const shouldRunNewsAPI = currentHour % 2 === 0

  const tasks     = [ collectFromRSS() ]
  const taskNames = [ 'RSS' ]

  // 유저 관심 키워드 수집 — Google News RSS 검색 (무료·무제한, 매 수집마다 수행)
  if (prefs.keywords.length > 0) {
    tasks.push(collectFromGoogleNewsKeywords(prefs.keywords, 10))
    taskNames.push('GoogleNews-keywords')
  }

  // NewsAPI 카테고리 수집 (짝수시간만, 429 서킷 브레이커 내장)
  if (shouldRunNewsAPI) {
    tasks.push(collectFromNewsAPI(config.news.apiKey, {
      country:    config.news.country,
      categories: prefs.categories,
      pageSize:   10,
    }))
    taskNames.push('NewsAPI-categories')
  } else {
    logger.info('[collector] Skipping NewsAPI categories on odd hours to conserve rate limits')
  }

  // 1) 모든 소스에서 병렬 수집
  const results = await Promise.allSettled(tasks)

  // 2) 결과 합산
  const allArticles = []
  results.forEach((r, i) => {
    const sourceName = taskNames[i] ?? 'unknown'
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
  try {
    const removed = await pruneOldPool(sb)
    logger.info(`[collector] Cleaned up ${removed} articles older than 7 days`)
  } catch (err) {
    logger.warn(`[collector] Cleanup failed: ${err.message}`)
  }

  const duration = ((Date.now() - startTime) / 1000).toFixed(1)
  logger.info(`[collector] Done in ${duration}s`)
}

main().catch(err => {
  logger.error(`[collector] FATAL: ${err.message}`)
  process.exit(1)
})
