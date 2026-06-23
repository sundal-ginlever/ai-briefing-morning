// src/collector/sources/newsapi.js
import { logger } from '../../utils/logger.js'
import { withRetry, isRetryable } from '../../utils/retry.js'
import { config } from '../../../config/index.js'

const BASE_URL_TOP = 'https://newsapi.org/v2/top-headlines'
const BASE_URL_EVERYTHING = 'https://newsapi.org/v2/everything'

/**
 * 키워드 기반 수집 (/v2/everything). 유저 관심 키워드를 OR로 묶어 검색.
 * pool에 산업/관심 주제 기사를 축적하기 위함.
 */
export async function collectFromNewsAPIByKeywords(apiKey, keywords, pageSize = 20) {
  if (!keywords || keywords.length === 0) return []

  const q   = keywords.join(' OR ')
  const url = `${BASE_URL_EVERYTHING}?apiKey=${apiKey}&q=${encodeURIComponent(q)}&language=en&sortBy=publishedAt&pageSize=${pageSize}`
  logger.info(`[collector:newsapi] Fetching by keywords: "${q}"`)

  const data = await withRetry(
    () => fetchCategory(url),
    { label: 'news:keywords', maxAttempts: 3, baseDelayMs: 3000, retryIf: isRetryable }
  )

  return (data.articles ?? []).map(a => ({
    title:        a.title       ?? '(no title)',
    description:  a.description ?? '',
    source_name:  a.source?.name ?? 'Unknown',
    source_type:  'newsapi',
    url:          a.url          ?? '',
    published_at: a.publishedAt  ?? new Date().toISOString(),
    categories:   [],
    keywords:     keywords,
    language:     'en',
  }))
}

export async function collectFromNewsAPI(apiKey, options = {}) {
  const { country, categories, pageSize } = options
  const targetPerCat = Math.ceil(pageSize / categories.length)
  const allArticles  = []

  for (const category of categories) {
    const url = buildUrl({ apiKey, country, category, pageSize: targetPerCat })
    logger.info(`[collector:newsapi] Fetching category="${category}" country="${country}"`)

    const data = await withRetry(
      () => fetchCategory(url),
      {
        label: `news:${category}`,
        maxAttempts: 3,
        baseDelayMs: 3000,
        retryIf: isRetryable,
      }
    )
    allArticles.push(...(data.articles ?? []))
  }

  return allArticles.map(a => normalizeArticle(a, categories))
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

function normalizeArticle(raw, categories) {
  return {
    title:        raw.title       ?? '(no title)',
    description:  raw.description ?? '',
    source_name:  raw.source?.name ?? 'Unknown',
    source_type:  'newsapi',
    url:          raw.url          ?? '',
    published_at: raw.publishedAt  ?? new Date().toISOString(),
    categories:   categories,
    language:     'en'
  }
}
