// src/local/check-and-retrigger.js
// GitHub Actions의 `schedule` 트리거는 베스트 에포트라, 부하가 몰리면 예약된 실행이
// 아예 드롭될 수 있고(2026-08-28 사고: 9시간+ 무실행) cron과 달리 놓친 틱을
// 스스로 따라잡지 않는다. 이 스크립트는 tts-worker의 07:30(1차) 실행 직전에 돌아
// "오늘자 대본이 아예 없는" 상태를 감지하면 workflow_dispatch로 즉시 재트리거한다.
//
// workflow_dispatch는 schedule과 달리 직접 API 요청이라 드롭되지 않고 곧바로
// 큐에 들어간다(실측 1분 15초 완료). 재트리거로 대본이 만들어지면, 뒤이은
// 08:00 tts-worker fallback이 정상적으로 집어서 음성까지 완성한다.
//
// 실행: node src/local/check-and-retrigger.js (07:30 크론에서만 호출, 08:00엔 불필요)

import { execFileSync } from 'child_process'
import { hasLogForDate } from '../providers/db.js'
import { logger }        from '../utils/logger.js'
import { todaySlug }     from '../utils/date.js'

const REPO = 'sundal-ginlever/ai-briefing-morning'
const WORKFLOW = 'daily-briefing.yml'
const GH = process.env.GH_BIN ?? '/opt/homebrew/bin/gh'

async function main() {
  const today = todaySlug(process.env.TZ || 'Asia/Seoul')
  const exists = await hasLogForDate(today)

  if (exists) {
    logger.info(`[check-and-retrigger] ${today} 로그 이미 존재 — 재트리거 불필요`)
    return
  }

  logger.warn(`[check-and-retrigger] ${today} 로그 없음 — GitHub Actions schedule 드롭 의심, workflow_dispatch로 재트리거`)
  try {
    execFileSync(GH, ['workflow', 'run', WORKFLOW, '--repo', REPO], { stdio: 'inherit' })
    logger.info('[check-and-retrigger] 재트리거 요청 완료 — 08:00 fallback이 결과를 집어갈 예정')
  } catch (err) {
    // 재트리거 자체가 실패해도 하드 스톱하지 않는다 — 08:00도 똑같이 "없음"을
    // 발견하고 조용히 종료할 뿐, 재트리거 이전 상태보다 나빠지지 않는다.
    logger.error(`[check-and-retrigger] 재트리거 실패: ${err.message}`)
  }
}

main().catch(err => {
  logger.error(`[check-and-retrigger] FATAL: ${err.message}`)
  process.exit(1)
})
