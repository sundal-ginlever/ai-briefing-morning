// src/collector/sources/rss.js
import { logger } from '../../utils/logger.js'

const DEFAULT_FEEDS = [
  {
    name: 'Google News - Top',
    url: 'https://news.google.com/rss?hl=en-US&gl=US&ceid=US:en',
    type: 'google-news',
    categories: ['general'],
  },
  {
    name: 'Google News - Technology',
    url: 'https://news.google.com/rss/topics/CAAqJggKIiBDQkFTRWdvSUwyMHZNRGRqTVhZU0FtVnVHZ0pWVXlnQVAB?hl=en-US&gl=US&ceid=US:en',
    type: 'google-news',
    categories: ['technology'],
  },
  {
    name: 'Hacker News',
    url: 'https://hnrss.org/frontpage?count=10',
    type: 'hackernews',
    categories: ['technology'],
  },
]

const GOOGLE_NEWS_SEARCH = 'https://news.google.com/rss/search'

/**
 * Google News RSS 키워드 검색. 키워드별로 따로 검색해 고르게 수집.
 * RSS라 무료·무제한(NewsAPI 쿼터와 무관) → 매 수집마다 호출 가능.
 */
export async function collectFromGoogleNewsKeywords(keywords, perKeyword = 10) {
  if (!keywords || keywords.length === 0) return []

  const all = []
  for (const kw of keywords) {
    const url = `${GOOGLE_NEWS_SEARCH}?q=${encodeURIComponent(kw)}&hl=en-US&gl=US&ceid=US:en`
    try {
      logger.info(`[collector:gnews] Searching keyword="${kw}"`)
      const res = await fetch(url)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const xml = await res.text()
      const items = parseRSSItems(xml).slice(0, perKeyword)
      for (const item of items) {
        all.push({
          title:        item.title,
          description:  item.description,
          source_name:  `Google News: ${kw}`,
          source_type:  'google-news-search',
          url:          item.link,
          published_at: item.pubDate ? new Date(item.pubDate).toISOString() : new Date().toISOString(),
          categories:   [],
          keywords:     [kw],
          language:     'en',
        })
      }
      logger.info(`[collector:gnews]   keyword="${kw}": ${items.length} items`)
    } catch (e) {
      logger.warn(`[collector:gnews] keyword="${kw}" failed: ${e.message}`)
    }
  }
  return all
}

export async function collectFromRSS(feeds = DEFAULT_FEEDS) {
  const allArticles = []
  
  for (const feed of feeds) {
    try {
      logger.info(`[collector:rss] Fetching feed="${feed.name}"`)
      const res = await fetch(feed.url)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const xml = await res.text()
      
      const items = parseRSSItems(xml)
      logger.info(`[collector:rss]   ${items.length} items found`)
      
      const normalized = items.map(item => ({
        title:        item.title,
        description:  item.description,
        source_name:  feed.name,
        source_type:  feed.type,
        url:          item.link,
        published_at: item.pubDate ? new Date(item.pubDate).toISOString() : new Date().toISOString(),
        categories:   feed.categories || [],
        language:     'en'
      }))
      allArticles.push(...normalized)
    } catch (err) {
      logger.warn(`[collector:rss] Failed to fetch feed="${feed.name}": ${err.message}`)
    }
  }
  
  return allArticles
}

function parseRSSItems(xml) {
  const items = []
  const itemRegex = /<item>([\s\S]*?)<\/item>/g
  let match
  while ((match = itemRegex.exec(xml)) !== null) {
    const block = match[1]
    items.push({
      title:       extractTag(block, 'title'),
      link:        extractTag(block, 'link'),
      description: extractTag(block, 'description'),
      pubDate:     extractTag(block, 'pubDate'),
    })
  }
  return items
}

function extractTag(block, tag) {
  // CDATA와 일반 태그 모두 대응
  const m = block.match(new RegExp(`<${tag}>(?:<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>|([\\s\\S]*?))<\\/${tag}>`))
  if (!m) return ''
  return (m[1] ?? m[2] ?? '').trim()
}
