// src/local/tts-worker.js
// 맥미니 로컬 TTS 워커 — VibeVoice로 음성을 만들고 발송까지 처리한다.
//
// 배경: 브리핑 파이프라인은 GitHub Actions에서 돌지만 Actions 러너는
// 맥미니의 로컬 모델에 접근할 수 없다. 그래서 역할을 나눈다.
//   Actions : 뉴스 선정 → 대본 생성 → DB 로그(audio_url=null) + MD 커밋
//   맥미니   : audio_url이 빈 로그를 집어 → TTS → 업로드 → 이메일 → audio_url 갱신
// DB를 큐로 쓰므로 맥미니가 꺼져 있어도 텍스트 브리핑은 정상 도착하고,
// 켜지면 밀린 음성을 따라잡는다.
//
// 실행: node src/local/tts-worker.js [--days=3] [--dry-run]

import { spawn }            from 'child_process'
import { readFileSync, writeFileSync, unlinkSync, existsSync, mkdirSync } from 'fs'
import { join, dirname }    from 'path'
import { fileURLToPath }    from 'url'
import { config }           from '../../config/index.js'
import { logger }           from '../utils/logger.js'
import { saveAudio }        from '../providers/storage.js'
import { sendBriefingEmail, sendFailureAlert } from '../providers/email.js'
import { getPendingAudioLogs, updateLogAudio, getRecipientEmail } from '../providers/db.js'
import { todayReadable }    from '../utils/date.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(__dirname, '..', '..')

const days     = parseInt(process.argv.find(a => a.startsWith('--days='))?.split('=')[1] ?? '3', 10)
const isDryRun = process.argv.includes('--dry-run')

// VibeVoice 런타임 — 모델과 venv는 레포 밖(25_vibevoice)에 있으므로 env로 주입
const VV = {
  python:    process.env.VIBEVOICE_PYTHON,
  model:     process.env.VIBEVOICE_MODEL,
  voicesDir: process.env.VIBEVOICE_VOICES_DIR,
  anchor:    process.env.VIBEVOICE_ANCHOR ?? 'Maya',
  body:      process.env.VIBEVOICE_BODY   ?? 'Frank,Alice,Carter,Alice,Carter',
  // 스래싱 방어: 정상은 6~9분이므로 그 3배를 넘으면 갈아대는 중으로 본다.
  // (네이티브 멀티화자 실패 시 13~30시간을 갈았던 전례가 있어 상한이 필수)
  timeoutMs: parseInt(process.env.VIBEVOICE_TIMEOUT_MS ?? '1800000', 10),
}

const ENV_NAMES = { python: 'VIBEVOICE_PYTHON', model: 'VIBEVOICE_MODEL', voicesDir: 'VIBEVOICE_VOICES_DIR' }

function assertRuntime() {
  const missing = Object.keys(ENV_NAMES).filter(k => !VV[k])
  if (missing.length) {
    throw new Error(`VibeVoice 설정 누락: ${missing.map(m => ENV_NAMES[m]).join(', ')}`)
  }
  if (!existsSync(VV.python))    throw new Error(`VIBEVOICE_PYTHON 없음: ${VV.python}`)
  if (!existsSync(VV.voicesDir)) throw new Error(`VIBEVOICE_VOICES_DIR 없음: ${VV.voicesDir}`)
}

/** 파이썬 릴레이 실행 → WAV 경로와 요약 반환. 타임아웃 시 강제 종료. */
function runRelay(scriptPath, outPath) {
  return new Promise((resolve, reject) => {
    const args = [
      join(REPO_ROOT, 'scripts', 'vibevoice_relay.py'),
      '--script', scriptPath,
      '--out',    outPath,
      '--model',  VV.model,
      '--voices-dir', VV.voicesDir,
      '--anchor', VV.anchor,
      '--body',   VV.body,
    ]
    const proc = spawn(VV.python, args, {
      env: { ...process.env, TOKENIZERS_PARALLELISM: 'false' },
    })

    let summary = null
    let stderr  = ''
    const timer = setTimeout(() => {
      proc.kill('SIGKILL')
      reject(new Error(`VibeVoice 타임아웃 (${VV.timeoutMs / 60000}분) — 스왑 스래싱 의심`))
    }, VV.timeoutMs)

    proc.stdout.on('data', chunk => {
      for (const line of String(chunk).split('\n')) {
        if (!line.trim()) continue
        if (line.startsWith('RELAY_RESULT ')) {
          try { summary = JSON.parse(line.slice('RELAY_RESULT '.length)) } catch { /* 무시 */ }
        } else {
          logger.info(`  ${line.trim()}`)
        }
      }
    })
    proc.stderr.on('data', c => { stderr += String(c) })

    proc.on('error', e => { clearTimeout(timer); reject(e) })
    proc.on('close', code => {
      clearTimeout(timer)
      if (code !== 0) return reject(new Error(`VibeVoice 종료코드 ${code}: ${stderr.slice(-500)}`))
      if (!summary)   return reject(new Error('VibeVoice 결과 요약 없음'))
      resolve(summary)
    })
  })
}

/** WAV → MP3 (파이프라인 산출물 형식을 Gemini 시절과 동일하게 유지) */
async function wavToMp3(wavPath) {
  const { execSync } = await import('child_process')
  const mp3Path = wavPath.replace(/\.wav$/, '.mp3')
  execSync(`ffmpeg -y -i "${wavPath}" -c:a libmp3lame -b:a 128k "${mp3Path}"`, { stdio: 'ignore' })
  return mp3Path
}

async function processLog(row) {
  const userTag = row.user_id ? `[user:${row.user_id.slice(0, 8)}]` : '[default]'
  logger.info(`${userTag} ${row.date} 음성 생성 시작`)

  const tmpDir = join(REPO_ROOT, '.tts-tmp')
  mkdirSync(tmpDir, { recursive: true })
  const base       = `${row.user_id ? row.user_id.slice(0, 8) : 'default'}-${row.date}`
  const scriptPath = join(tmpDir, `${base}.txt`)
  const wavPath    = join(tmpDir, `${base}.wav`)
  let mp3Path      = null

  try {
    writeFileSync(scriptPath, row.script, 'utf8')

    const summary = await runRelay(scriptPath, wavPath)
    logger.info(`${userTag} 오디오 ${summary.duration_sec}초 / 생성 ${summary.generate_sec}초 / RTF ${summary.rtf}x / 보이스 ${summary.voices.join(',')}`)

    if (isDryRun) {
      logger.info(`${userTag} DRY RUN — 업로드/발송 생략 (${wavPath})`)
      return
    }

    mp3Path = await wavToMp3(wavPath)
    const audioBuffer = readFileSync(mp3Path)
    const audioUrl    = await saveAudio(audioBuffer, `${base}.mp3`)

    // 업로드가 끝나면 곧바로 audio_url을 채운다.
    // 이메일 실패로 재실행되더라도 음성을 다시 만들지 않게 하기 위함(6~9분 낭비 방지).
    await updateLogAudio(row.id, audioUrl, 'vibevoice', Math.round(summary.duration_sec * 1000))

    const to = await getRecipientEmail(row.user_id) || config.email.to
    if (!to) {
      logger.warn(`${userTag} 수신 이메일을 찾을 수 없어 발송 생략`)
      return
    }

    const headlines = Array.isArray(row.articles) ? row.articles.map(a => a.title).filter(Boolean) : []
    await sendBriefingEmail({
      audioUrl, script: row.script, headlines,
      date: todayReadable(process.env.TZ || 'Asia/Seoul'),
      to,
    })
    logger.info(`${userTag} ${row.date} 완료`)
  } finally {
    for (const p of [scriptPath, wavPath, mp3Path]) {
      if (p && existsSync(p)) { try { unlinkSync(p) } catch { /* 무시 */ } }
    }
  }
}

// 중복 실행 방지 — 워커 두 개가 겹치면 모델이 두 벌 올라가 스왑이 터진다.
// 여러 시각에 크론을 걸어 따라잡기를 노리므로 락이 반드시 필요하다.
const LOCK = join(REPO_ROOT, '.tts-worker.lock')

function acquireLock() {
  if (existsSync(LOCK)) {
    const pid = parseInt(readFileSync(LOCK, 'utf8').trim(), 10)
    let alive = false
    try { process.kill(pid, 0); alive = true } catch { alive = false }
    if (alive) return false
    logger.warn(`[tts-worker] 죽은 락 정리 (pid=${pid})`)
  }
  writeFileSync(LOCK, String(process.pid), 'utf8')
  return true
}

function releaseLock() {
  if (existsSync(LOCK)) { try { unlinkSync(LOCK) } catch { /* 무시 */ } }
}

async function main() {
  assertRuntime()
  if (!acquireLock()) {
    logger.info('[tts-worker] 다른 인스턴스가 실행 중 — 종료')
    return
  }
  logger.info(`[tts-worker] 대기중인 브리핑 조회 (최근 ${days}일)`)

  const pending = await getPendingAudioLogs(days)
  if (pending.length === 0) {
    logger.info('[tts-worker] 처리할 항목 없음')
    return
  }
  logger.info(`[tts-worker] ${pending.length}건 발견`)

  let ok = 0, fail = 0
  // 순차 처리 — 동시에 돌리면 모델이 여러 개 올라가 스왑이 터진다
  for (const row of pending) {
    try {
      await processLog(row)
      ok++
    } catch (err) {
      fail++
      logger.error(`[tts-worker] ${row.date} 실패: ${err.message}`)
      await sendFailureAlert({
        userId: row.user_id, date: row.date,
        errorMessage: `로컬 TTS 실패: ${err.message}`,
      }).catch(() => {})
    }
  }
  logger.info(`[tts-worker] 완료 ok=${ok} fail=${fail}`)
}

// 어떤 경로로 끝나든 락은 반드시 푼다
process.on('exit',   releaseLock)
process.on('SIGINT', () => { releaseLock(); process.exit(130) })
process.on('SIGTERM',() => { releaseLock(); process.exit(143) })

main()
  .then(() => { releaseLock(); process.exit(0) })
  .catch(err => { releaseLock(); logger.error(`[tts-worker] FATAL: ${err.message}`); process.exit(1) })
