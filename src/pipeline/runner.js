// src/pipeline/runner.js  (Phase 3 — 병렬 실행 + 뉴스 캐싱)
// 단일 실행 or 전체 사용자 스케줄 실행 모두 지원.
//
// 실행 방법:
//   node src/pipeline/runner.js                  → 전체 활성 사용자 실행
//   node src/pipeline/runner.js --dry-run        → 뉴스 수집만
//   node src/pipeline/runner.js --user=<userId>  → 특정 사용자만

import { fetchNews }           from './news.js'
import { generateScript }      from '../providers/llm.js'
import { synthesizeSpeech }    from '../providers/tts.js'
import { saveAudio }           from '../providers/storage.js'
import { sendBriefingEmail }   from '../providers/email.js'
import { saveBriefingLog }     from '../providers/db.js'
import { logger }              from '../utils/logger.js'
import { todaySlug, todayReadable } from '../utils/date.js'
import {
  getActiveUsersToProcess,
  hasLogForDate,
  getUserSettings,
  settingsToOverride,
} from '../api/users.js'
import { fetchArticlesFromPool, markArticlesAsUsed } from '../collector/pool-reader.js'
import { config } from '../../config/index.js'

const isDryRun   = process.argv.includes('--dry-run')
const targetUser = process.argv.find(a => a.startsWith('--user='))?.split('=')[1]

// ─── Phase 3: 동시성 제어 상수 ──────────────────────────────────────────────
const MAX_CONCURRENCY = parseInt(process.env.MAX_CONCURRENCY ?? '5', 10)

// ─── Phase 3: NewsAPI 인메모리 캐시 ──────────────────────────────────────────
// 같은 카테고리+국가를 구독하는 여러 유저가 동시에 실행될 때
// NewsAPI를 한 번만 호출하고 결과를 공유합니다.
const NEWS_CACHE_TTL_MS = 10 * 60 * 1000   // 10분
const newsCache = new Map()                // key → { data, expiresAt, promise? }

/**
 * 캐시 적용 뉴스 fetch.
 * 동일 키에 대해 동시 요청이 들어오면 하나의 API 호출만 실행하고 나머지는 대기합니다.
 */
async function fetchNewsWithCache(newsOpts = {}) {
  const cacheKey = buildNewsCacheKey(newsOpts)

  // 1) 유효한 캐시 히트
  const cached = newsCache.get(cacheKey)
  if (cached) {
    if (cached.data && Date.now() < cached.expiresAt) {
      logger.info(`[news-cache] HIT key="${cacheKey}" (${cached.data.length} articles)`)
      return cached.data
    }
    // 2) 다른 코루틴이 이미 fetch 중이면 그 결과를 대기
    if (cached.promise) {
      logger.info(`[news-cache] PENDING key="${cacheKey}" — waiting...`)
      return await cached.promise
    }
  }

  // 3) 캐시 미스 — fetch 시작하고 promise를 등록
  logger.info(`[news-cache] MISS key="${cacheKey}" — fetching...`)
  const entry = { data: null, expiresAt: 0, promise: null }

  entry.promise = fetchNews(newsOpts)
    .then(articles => {
      entry.data      = articles
      entry.expiresAt = Date.now() + NEWS_CACHE_TTL_MS
      entry.promise   = null
      return articles
    })
    .catch(err => {
      newsCache.delete(cacheKey)   // 실패 시 캐시에서 제거
      throw err
    })

  newsCache.set(cacheKey, entry)
  return await entry.promise
}

function buildNewsCacheKey(opts) {
  const country    = opts.country    ?? config.news.country
  const categories = opts.categories ?? config.news.categories
  const pageSize   = opts.pageSize   ?? config.news.pageSize
  return `${country}:${[...categories].sort().join(',')}:${pageSize}`
}

/** 스케줄 완료 후 캐시 정리 */
function clearExpiredNewsCache() {
  const now = Date.now()
  for (const [key, entry] of newsCache) {
    if (entry.expiresAt > 0 && now >= entry.expiresAt) {
      newsCache.delete(key)
    }
  }
}

// ─── 단일 사용자 파이프라인 ───────────────────────────────────────────────────

export async function runPipeline({ userId = null, override = {}, useCache = false, forceDate = null } = {}) {
  const startTime = Date.now()
  const date      = forceDate || todaySlug(override.schedule?.timezone || 'UTC')
  const dateLabel = todayReadable(override.schedule?.timezone || 'UTC')
  const userTag   = userId ? `[user:${userId.slice(0,8)}]` : '[default]'

  logger.info(`=== Briefing Pipeline ${userTag} === ${dateLabel} ${isDryRun ? '[DRY RUN]' : ''}`)

  const newsOpts     = override.news     ?? {}
  const briefingOpts = override.briefing ?? {}
  const emailTo      = override.email?.to ?? config.email.to

  // LLM/TTS per-user override — config injection
  const llmOpts = override.llm ?? {}
  const ttsOpts = override.tts ?? {}

  // Step 1 — 뉴스 수집 (pool 우선, 폴백: 실시간 호출)
  logger.info(`${userTag} [1/6] Fetching news`)
  let articles
  try {
    articles = await fetchArticlesFromPool(userId, newsOpts.keywords, newsOpts.pageSize ?? 5)
    if (articles.length > 0) {
      logger.info(`${userTag} Using ${articles.length} articles from news pool`)
    } else {
      throw new Error('Pool empty')
    }
  } catch (e) {
    logger.info(`${userTag} Pool unavailable (${e.message}), falling back to live fetch`)
    articles = useCache
      ? await fetchNewsWithCache(newsOpts)
      : await fetchNews(newsOpts)
  }
  if (articles.length === 0) throw new Error('No articles available')
  articles.forEach((a, i) => logger.info(`  ${i+1}. ${a.title}`))

  if (isDryRun) {
    logger.info(`${userTag} DRY RUN done`)
    return { userId, articles }
  }

  // Step 2
  logger.info(`${userTag} [2/6] Generating script`)
  const script = await generateScript(articles, override)
  logger.info(`${userTag} Script: "${script.slice(0,80)}..."`)

  // Step 3
  logger.info(`${userTag} [3/6] Synthesizing audio (with pauses)`)
  const scriptChunks = script.split(/\[PAUSE\]/i).map(c => c.trim()).filter(Boolean)
  const audioBuffers = []
  
  let silenceBuf = null
  try {
    const { readFileSync } = await import('fs')
    const { join } = await import('path')
    const { fileURLToPath } = await import('url')
    const __dirname = await import('path').then(p => p.dirname(fileURLToPath(import.meta.url)))
    silenceBuf = readFileSync(join(__dirname, '../assets/silence_1s.mp3'))
  } catch (e) {
    logger.warn(`[tts] Failed to load silence_1s.mp3: ${e.message}`)
  }

  for (let i = 0; i < scriptChunks.length; i++) {
    logger.info(`${userTag} Synthesizing chunk ${i+1}/${scriptChunks.length}`)
    const buf = await synthesizeSpeech(scriptChunks[i], override)
    if (buf) {
      audioBuffers.push(buf)
      if (i < scriptChunks.length - 1 && silenceBuf) {
        audioBuffers.push(silenceBuf)
      }
    }
  }
  const audioBuffer = audioBuffers.length > 0 ? Buffer.concat(audioBuffers) : null

  // Step 4
  logger.info(`${userTag} [4/6] Saving audio`)
  const filename = userId ? `${userId.slice(0,8)}-${date}.mp3` : `${date}.mp3`
  const audioUrl = await saveAudio(audioBuffer, filename)

  // Step 5
  logger.info(`${userTag} [5/6] Sending email to ${emailTo}`)
  await sendBriefingEmail({ audioUrl, script, headlines: articles.map(a => a.title), date: dateLabel, to: emailTo })

  // Step 6
  logger.info(`${userTag} [6/7] Saving log`)
  const durationMs = Date.now() - startTime
  await saveBriefingLog({ userId, date, script, audioUrl, articles,
    llmProvider: override.llm?.provider ?? config.llm.provider,
    ttsProvider: override.tts?.provider ?? config.tts.provider,
    durationMs })

  // Step 7: GitHub 동기화를 위한 로컬 MD 저장 (옵시디언 연동용)
  logger.info(`${userTag} [7/7] Saving MD locally for GitHub Sync`)
  const mdFilename = userId ? `${userId.slice(0,8)}-${date}.md` : `${date}.md`
  try {
    const { writeFileSync, mkdirSync } = await import('fs')
    const { join } = await import('path')
    const outDir = join(process.cwd(), 'briefings')
    mkdirSync(outDir, { recursive: true })
    writeFileSync(join(outDir, mdFilename), script, 'utf8')
    logger.info(`${userTag} Saved ${mdFilename} to briefings/`)
  } catch (err) {
    logger.warn(`${userTag} Failed to save MD locally: ${err.message}`)
  }

  // Mark pool articles as used
  try {
    const poolUrls = articles.map(a => a.url).filter(Boolean)
    if (poolUrls.length > 0) await markArticlesAsUsed(poolUrls)
  } catch (e) {
    logger.warn(`${userTag} Failed to mark pool articles: ${e.message}`)
  }

  logger.info(`${userTag} Done in ${(durationMs/1000).toFixed(1)}s`)
  return { userId, articles, script, audioUrl, durationMs }
}

// ─── Phase 3: 동시성 제어 병렬 실행기 ─────────────────────────────────────────

/**
 * 최대 concurrency개의 작업을 동시에 실행하는 풀 방식 병렬 처리기.
 * Promise.allSettled만으로는 동시성 제한이 불가능하므로
 * 세마포어 패턴을 직접 구현합니다.
 *
 * @param {Array<() => Promise>} tasks   - 실행할 async 함수 배열
 * @param {number} concurrency           - 최대 동시 실행 수
 * @returns {Promise<Array<{status, value?, reason?}>>}
 */
async function runWithConcurrency(tasks, concurrency) {
  const results = new Array(tasks.length)
  let nextIndex = 0

  async function worker() {
    while (nextIndex < tasks.length) {
      const idx = nextIndex++
      try {
        results[idx] = { status: 'fulfilled', value: await tasks[idx]() }
      } catch (err) {
        results[idx] = { status: 'rejected', reason: err }
      }
    }
  }

  // 워커를 concurrency개만큼 생성하여 병렬 실행
  const workers = Array.from(
    { length: Math.min(concurrency, tasks.length) },
    () => worker()
  )
  await Promise.all(workers)
  return results
}

// ─── 멀티유저 스케줄 (Phase 4: 지연 실행 대응 & 중복 방지) ──────────────────────

export async function runScheduledUsers() {
  const schedulerStart = Date.now()
  const hourUtc = new Date().getUTCHours()
  logger.info(`[scheduler] UTC hour=${hourUtc} | concurrency=${MAX_CONCURRENCY}`)

  let candidates
  try {
    candidates = await getActiveUsersToProcess()
  } catch (err) {
    logger.error(`[scheduler] Failed to get candidates from DB: ${err.message}`)
    return
  }

  if (!candidates || candidates.length === 0) {
    logger.info(`[scheduler] No active scheduled users found.`)
    return
  }

  // 2) 조건 필터링: (1) 지연 허용 범위 내인가? (2) 오늘 이미 받았는가?
  const usersToRun = []
  for (const row of candidates) {
    const userId = row.a_user_profiles.id
    const userTz = row.timezone || 'Asia/Seoul'
    const date   = todaySlug(userTz) // 사용자 시간대 기준 날짜 계산
    
    // 0~3 시간 이내로 늦은 경우 허용 (예: 스케줄이 23시이고 현재가 1시이면 diff=2)
    const diffHours = (hourUtc - row.schedule_hour_utc + 24) % 24
    
    if (diffHours >= 0 && diffHours <= 3) {
      const alreadyDone = await hasLogForDate(userId, date)
      if (!alreadyDone) {
        usersToRun.push({ ...row, calculatedDate: date })
      } else {
        logger.info(`[scheduler] Skipping userId=${userId.slice(0,8)} — already processed for ${date} (${userTz})`)
      }
    } else {
      // 3시간 이상 차이나면 실행할 시간이 아님
      logger.info(`[scheduler] Skipping userId=${userId.slice(0,8)} — schedule=${row.schedule_hour_utc} UTC, now=${hourUtc} UTC (diff=${diffHours}h)`)
    }
  }

  if (usersToRun.length === 0) {
    logger.info(`[scheduler] All candidates already processed.`)
    return
  }

  logger.info(`[scheduler] Running ${usersToRun.length} user(s) pending for their respective dates`)

  // 3) 태스크 생성 및 실행
  const tasks = usersToRun.map(row => {
    const profile  = row.a_user_profiles
    const override = settingsToOverride(row)
    return () => runPipeline({ 
      userId:   profile.id, 
      override, 
      useCache: true,
      forceDate: row.calculatedDate // 미리 계산된 날짜 전달
    })
  })

  const results = await runWithConcurrency(tasks, MAX_CONCURRENCY)

  // 결과 집계
  const ok   = results.filter(r => r.status === 'fulfilled').length
  const fail = results.filter(r => r.status === 'rejected').length

  // 실패한 유저 상세 로깅
  results.forEach((r, i) => {
    if (r.status === 'rejected') {
      const profile = usersToRun[i].a_user_profiles
      logger.error(`[scheduler] Failed userId=${profile.id}: ${r.reason?.message || r.reason}`)
    }
  })

  // 스케줄 완료 후 만료된 뉴스 캐시 정리
  clearExpiredNewsCache()

  const totalDuration = ((Date.now() - schedulerStart) / 1000).toFixed(1)
  logger.info(`[scheduler] ok=${ok} fail=${fail} | total=${totalDuration}s`)
}

// ─── CLI ─────────────────────────────────────────────────────────────────────

if (process.argv[1].endsWith('runner.js')) {
  const run = async () => {
    if (targetUser) {
      const settings = await getUserSettings(targetUser)
      await runPipeline({ userId: targetUser, override: settingsToOverride(settings) })
    } else if (isDryRun) {
      await runPipeline()
    } else {
      await runScheduledUsers()
    }
  }
  run().then(() => process.exit(0)).catch(err => {
    logger.error(`FATAL: ${err.message}`)
    process.exit(1)
  })
}
