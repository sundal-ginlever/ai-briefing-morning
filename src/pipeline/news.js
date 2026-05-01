// src/pipeline/news.js
// NewsAPI 헤드라인 수집. retry + 429 rate limit 처리 포함.

import { config }                 from '../../config/index.js'
import { logger }                 from '../utils/logger.js'
import { withRetry, isRetryable } from '../utils/retry.js'

const BASE_URL = 'https://newsapi.org/v2/top-headlines'

export async function fetchNews(override = {}) {
  const { apiKey, country, categories, pageSize } = { ...config.news, ...override }
  const targetPerCat = Math.ceil(pageSize / categories.length)
  const allArticles  = []

  for (const category of categories) {
    const url = buildUrl({ apiKey, country, category, pageSize: targetPerCat })
    logger.info(`[news] Fetching category="${category}" country="${country}"`)

    const data = await withRetry(
      () => fetchCategory(url),
      {
        label: `news:${category}`,
        maxAttempts: 3,
        baseDelayMs: 3000,   // NewsAPI rate limit은 좀 더 기다림
        retryIf: isRetryable,
      }
    )
    allArticles.push(...(data.articles ?? []))
  }

  // 중복 제거 (URL 기준) + pageSize 상한
  const seen   = new Set()
  const unique = allArticles.filter(a => {
    if (!a.url || seen.has(a.url)) return false
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
  return `${BASE_URL}?${p}`
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
