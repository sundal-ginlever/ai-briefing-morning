// src/utils/date.js

/**
 * Returns today's date as "YYYY-MM-DD" in local time.
 */
export function todaySlug() {
  return new Date().toISOString().slice(0, 10)
}

/**
 * Returns a human-readable date string like "April 24, 2025".
 */
export function todayReadable() {
  return new Date().toLocaleDateString('en-US', {
    year:  'numeric',
    month: 'long',
    day:   'numeric',
  })
}
