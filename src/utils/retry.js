// src/utils/retry.js
// 지수 백오프 재시도 유틸리티.

import { logger } from './logger.js'

/**
 * fn을 최대 maxAttempts번 재시도. 실패 시 지수 백오프 대기.
 * @param {() => Promise<T>} fn
 * @param {object} opts
 * @param {number} opts.maxAttempts   기본 3
 * @param {number} opts.baseDelayMs   기본 1000
 * @param {number} opts.maxDelayMs    기본 15000
 * @param {string} opts.label
 * @param {(e:Error)=>boolean} opts.retryIf  false 반환 시 즉시 포기
 */
export async function withRetry(fn, {
  maxAttempts = 3,
  baseDelayMs = 1000,
  maxDelayMs  = 15000,
  label       = 'operation',
  retryIf     = () => true,
} = {}) {
  let lastErr
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn()
    } catch (err) {
      lastErr = err
      if (!retryIf(err)) {
        logger.warn(`[retry] ${label} non-retryable: ${err.message}`)
        throw err
      }
      if (attempt === maxAttempts) break
      const delay = Math.min(baseDelayMs * 2 ** (attempt - 1), maxDelayMs)
      logger.warn(`[retry] ${label} attempt ${attempt}/${maxAttempts} failed (${err.message}) — retrying in ${delay}ms`)
      await new Promise(r => setTimeout(r, delay))
    }
  }
  logger.error(`[retry] ${label} all ${maxAttempts} attempts failed`)
  throw lastErr
}

/** 5xx, 429, 네트워크 에러는 재시도. 4xx 클라이언트 에러는 포기. */
export function isRetryable(err) {
  const status = err.status ?? err.statusCode ?? 0
  const msg    = err.message?.toLowerCase() ?? ''
  if (status === 429)              return true
  if (status >= 500)               return true
  if (status >= 400 && status < 500) return false
  if (msg.includes('fetch failed'))  return true
  if (msg.includes('econnreset'))    return true
  if (msg.includes('etimedout'))     return true
  return true
}
