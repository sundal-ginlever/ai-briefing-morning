// src/collector/dedup.js
export function deduplicateArticles(articles) {
  const seen = new Set()
  return articles.filter(a => {
    if (!a.url || seen.has(a.url)) return false
    if (a.title === '[Removed]' || !a.title) return false
    seen.add(a.url)
    return true
  })
}
