// src/providers/email.js
// Sends the daily briefing email with audio link.

import { config } from '../../config/index.js'
import { logger } from '../utils/logger.js'

/**
 * Send briefing delivery email.
 * @param {object} params
 * @param {string} params.audioUrl    - Link to the MP3
 * @param {string} params.script      - Briefing text (shown in email body)
 * @param {string[]} params.headlines - Article titles for quick preview
 * @param {string} params.date        - "April 24, 2025"
 */
export async function sendBriefingEmail({ audioUrl, script, headlines, date, to }) {
  if (config.email.provider === 'none') {
    logger.info('[email] provider=none, skipping delivery')
    return
  }

  logger.info(`[email] sending to ${config.email.to}...`)

  const { createTransport } = await import('nodemailer')
  const transporter = createTransport({
    host: config.email.smtp.host,
    port: config.email.smtp.port,
    secure: config.email.smtp.port === 465,
    auth: {
      user: config.email.smtp.user,
      pass: config.email.smtp.pass,
    },
  })

  const html = buildEmailHTML({ audioUrl, script, headlines, date })
  const text = buildEmailText({ audioUrl, script, headlines, date })

  const info = await transporter.sendMail({
    from:    `"Morning Briefing" <${config.email.from}>`,
    to:      to ?? config.email.to,
    subject: `☀️ Morning Briefing — ${date}`,
    text,
    html,
  })

  logger.info(`[email] sent messageId=${info.messageId}`)
}

// ─── Templates ───────────────────────────────────────────────────────────────

function buildEmailHTML({ audioUrl, script, headlines, date }) {
  const headlineItems = headlines
    .map(h => `<li style="margin-bottom:6px">${h}</li>`)
    .join('')

  const audioSection = audioUrl && !audioUrl.startsWith('file://')
    ? `<div style="margin:24px 0;text-align:center">
        <a href="${audioUrl}"
           style="background:#1a1a2e;color:#fff;padding:14px 32px;
                  border-radius:8px;text-decoration:none;font-size:16px;
                  font-weight:600;display:inline-block">
          ▶ Listen to Today's Briefing
        </a>
      </div>`
    : '<p style="color:#888">(Audio not available — script below)</p>'

  return `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
             max-width:600px;margin:0 auto;padding:24px;color:#1a1a1a">
  <h1 style="font-size:22px;margin-bottom:4px">☀️ Morning Briefing</h1>
  <p style="color:#888;margin-top:0">${date}</p>
  <hr style="border:none;border-top:1px solid #eee;margin:20px 0">

  <h2 style="font-size:16px">Today's Stories</h2>
  <ul style="padding-left:20px;line-height:1.7">${headlineItems}</ul>

  ${audioSection}

  <details style="margin-top:24px">
    <summary style="cursor:pointer;color:#555;font-size:14px">
      Read the script
    </summary>
    <p style="white-space:pre-wrap;font-size:14px;line-height:1.8;
              color:#333;background:#f9f9f9;padding:16px;border-radius:8px;
              margin-top:12px">${script}</p>
  </details>

  <p style="color:#ccc;font-size:12px;margin-top:32px">
    Morning Briefing • auto-generated
  </p>
</body>
</html>`
}

function buildEmailText({ audioUrl, script, headlines, date }) {
  return [
    `Morning Briefing — ${date}`,
    '',
    "Today's Stories:",
    ...headlines.map((h, i) => `${i + 1}. ${h}`),
    '',
    audioUrl && !audioUrl.startsWith('file://')
      ? `Listen: ${audioUrl}`
      : '(Audio not available)',
    '',
    '--- Script ---',
    script,
  ].join('\n')
}
