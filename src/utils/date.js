// src/utils/date.js

/**
 * Returns today's date as "YYYY-MM-DD" in local time.
 */
/**
 * Returns today's date as "YYYY-MM-DD" in the given timezone.
 * Defaults to UTC if no timezone is provided.
 */
export function todaySlug(timezone = 'UTC') {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).format(new Date())
  } catch (err) {
    // 폴백: 타임존이 잘못된 경우 UTC 사용
    return new Date().toISOString().slice(0, 10)
  }
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
