// src/pipeline/news.js
// NewsAPI 헤드라인 수집. retry + 429 rate limit 처리 포함.

import { config }                 from '../../config/index.js'
import { logger }                 from '../utils/logger.js'
import { withRetry, isRetryable } from '../utils/retry.js'

const BASE_URL_TOP = 'https://newsapi.org/v2/top-headlines'
const BASE_URL_EVERYTHING = 'https://newsapi.org/v2/everything'

export async function fetchNews(override = {}) {
  const { apiKey, country, categories, keywords, pageSize } = { ...config.news, ...override }
  const allArticles  = []

  // If keywords are provided, use /v2/everything
  if (keywords && keywords.length > 0) {
    const q = keywords.join(' OR ')
    const url = `${BASE_URL_EVERYTHING}?apiKey=${apiKey}&q=${encodeURIComponent(q)}&language=en&sortBy=publishedAt&pageSize=${pageSize}`
    logger.info(`[news] Fetching by keywords: "${q}"`)
    
    const data = await withRetry(() => fetchCategory(url), {
      label: `news:keywords`, maxAttempts: 3, baseDelayMs: 3000, retryIf: isRetryable
    })
    allArticles.push(...(data.articles ?? []))
  } else {
    // Fallback to top-headlines by category
    const targetPerCat = Math.ceil(pageSize / categories.length)
    for (const category of categories) {
      const url = buildUrl({ apiKey, country, category, pageSize: targetPerCat })
      logger.info(`[news] Fetching category="${category}" country="${country}"`)

      const data = await withRetry(() => fetchCategory(url), {
        label: `news:${category}`, maxAttempts: 3, baseDelayMs: 3000, retryIf: isRetryable
      })
      allArticles.push(...(data.articles ?? []))
    }
  }

  // 중복 제거 (URL 기준) + pageSize 상한
  const seen   = new Set()
  const unique = allArticles.filter(a => {
    if (!a.url || seen.has(a.url) || a.title === '[Removed]') return false
    seen.add(a.url)
    return true
  })

  const result = unique.slice(0, pageSize).map(normalizeArticle)
  logger.info(`[news] ${result.length} articles fetched`)
  return result
}

async function fetchCategory(url) {
  const res = await fetch(url)
  if (!res.ok) {
    const body   = await res.text()
    const err    = new Error(`NewsAPI ${res.status}: ${body}`)
    err.status   = res.status
    throw err
  }
  const data = await res.json()
  if (data.status !== 'ok') {
    // code: "rateLimited" → 429처럼 처리
    const err  = new Error(`NewsAPI status="${data.status}" code="${data.code}"`)
    err.status = data.code === 'rateLimited' ? 429 : 400
    throw err
  }
  return data
}

function buildUrl({ apiKey, country, category, pageSize }) {
  const p = new URLSearchParams({ apiKey, country, pageSize: String(pageSize) })
  if (category && category !== 'general') p.set('category', category)
  return `${BASE_URL_TOP}?${p}`
}

function normalizeArticle(raw) {
  return {
    title:       raw.title       ?? '(no title)',
    description: raw.description ?? '',
    source:      raw.source?.name ?? 'Unknown',
    url:         raw.url          ?? '',
    publishedAt: raw.publishedAt  ?? new Date().toISOString(),
  }
}
