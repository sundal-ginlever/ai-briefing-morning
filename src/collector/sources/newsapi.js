// src/collector/sources/newsapi.js
import { logger } from '../../utils/logger.js'
import { withRetry, isRetryable } from '../../utils/retry.js'
import { config } from '../../../config/index.js'

const BASE_URL_TOP = 'https://newsapi.org/v2/top-headlines'

// ─── 서킷 브레이커 ──────────────────────────────────────────────────────────
// 한 번이라도 rateLimited(429)를 만나면 이 프로세스에서 NewsAPI 호출을 즉시 중단한다.
// (429를 재시도하면 호출이 증폭돼 한도를 더 빨리 소진하는 악순환을 막기 위함)
let newsApiRateLimited = false
export function isNewsApiRateLimited() { return newsApiRateLimited }

export async function collectFromNewsAPI(apiKey, options = {}) {
  const { country, categories, pageSize } = options
  const targetPerCat = Math.ceil(pageSize / categories.length)
  const allArticles  = []

  for (const category of categories) {
    if (newsApiRateLimited) {
      logger.warn(`[collector:newsapi] rate limited — skipping remaining categories`)
      break
    }

    const url = buildUrl({ apiKey, country, category, pageSize: targetPerCat })
    logger.info(`[collector:newsapi] Fetching category="${category}" country="${country}"`)

    try {
      const data = await withRetry(
        () => fetchCategory(url),
        {
          label: `news:${category}`,
          maxAttempts: 3,
          baseDelayMs: 3000,
          // 429는 재시도하지 않음 (서킷 브레이커) — 폭주 방지
          retryIf: (e) => (e.status ?? 0) !== 429 && isRetryable(e),
        }
      )
      allArticles.push(...(data.articles ?? []).map(a => normalizeArticle(a, [category])))
    } catch (e) {
      logger.warn(`[collector:newsapi] category="${category}" failed: ${e.message}`)
      if (newsApiRateLimited) break
    }
  }

  return allArticles
}

async function fetchCategory(url) {
  const res = await fetch(url)
  if (!res.ok) {
    const body   = await res.text()
    const err    = new Error(`NewsAPI ${res.status}: ${body}`)
    err.status   = res.status
    if (res.status === 429) newsApiRateLimited = true
    throw err
  }
  const data = await res.json()
  if (data.status !== 'ok') {
    const err  = new Error(`NewsAPI status="${data.status}" code="${data.code}"`)
    err.status = data.code === 'rateLimited' ? 429 : 400
    if (data.code === 'rateLimited') newsApiRateLimited = true
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
