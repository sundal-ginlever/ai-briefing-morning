// src/collector/sources/newsapi.js
import { logger } from '../../utils/logger.js'
import { withRetry, isRetryable } from '../../utils/retry.js'
import { config } from '../../../config/index.js'

const BASE_URL_TOP = 'https://newsapi.org/v2/top-headlines'
const BASE_URL_EVERYTHING = 'https://newsapi.org/v2/everything'

/**
 * 키워드 기반 수집 (/v2/everything). 각 키워드를 "따로" 검색해서
 * 흔한 키워드(예: AI)가 결과를 독식하지 않고 키워드별로 고르게 pool에 축적되게 한다.
 * 호출 수 = 키워드 수 이므로, collect.js에서 하루 1~2회만 호출하도록 제한한다.
 */
export async function collectFromNewsAPIByKeywords(apiKey, keywords, perKeyword = 10) {
  if (!keywords || keywords.length === 0) return []

  const all = []
  for (const kw of keywords) {
    // 정확 구문 검색을 위해 따옴표로 감쌈
    const url = `${BASE_URL_EVERYTHING}?apiKey=${apiKey}&q=${encodeURIComponent(`"${kw}"`)}&language=en&sortBy=publishedAt&pageSize=${perKeyword}`
    logger.info(`[collector:newsapi] Fetching keyword="${kw}"`)
    try {
      const data = await withRetry(
        () => fetchCategory(url),
        { label: `news:kw:${kw}`, maxAttempts: 2, baseDelayMs: 3000, retryIf: isRetryable }
      )
      for (const a of (data.articles ?? [])) {
        all.push({
          title:        a.title       ?? '(no title)',
          description:  a.description ?? '',
          source_name:  a.source?.name ?? 'Unknown',
          source_type:  'newsapi',
          url:          a.url          ?? '',
          published_at: a.publishedAt  ?? new Date().toISOString(),
          categories:   [],
          keywords:     [kw],
          language:     'en',
        })
      }
    } catch (e) {
      logger.warn(`[collector:newsapi] keyword="${kw}" failed: ${e.message}`)
    }
  }
  return all
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
