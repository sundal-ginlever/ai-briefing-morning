// src/utils/logger.js
// Minimal structured logger.
// In production (Railway), stdout is captured by the log aggregator.

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 }
const MIN_LEVEL = LEVELS[process.env.LOG_LEVEL?.toLowerCase()] ?? LEVELS.info

function log(level, message) {
  if (LEVELS[level] < MIN_LEVEL) return
  const ts = new Date().toISOString()
  const line = `${ts} [${level.toUpperCase()}] ${message}`
  if (level === 'error' || level === 'warn') {
    console.error(line)
  } else {
    console.log(line)
  }
}

export const logger = {
  debug: (msg) => log('debug', msg),
  info:  (msg) => log('info',  msg),
  warn:  (msg) => log('warn',  msg),
  error: (msg) => log('error', msg),
}
