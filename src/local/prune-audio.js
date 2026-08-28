// src/local/prune-audio.js
// 오래된 오디오 파일 정리 — 스토리지 용량 관리.
//
// 왜 지워도 되나: 오디오는 파생물이고 원본인 대본 텍스트는 삼중으로 남는다.
//   1) git 저장소 briefings/*.md (2026-05-25~ 전량, 영구)
//   2) Google Drive Obsidian 동기화 (매일 07:10)
//   3) Supabase a_briefing_logs.script
// 따라서 필요하면 텍스트로 언제든 다시 합성할 수 있다.
//
// 왜 40일인가: 피드·히스토리가 30일치를 싣는다. 삭제도 30일로 잡으면 동기화가
// 늦은 구독자가 목록의 가장 오래된 회차에서 404를 맞는다. 10일 완충을 둔다.
//
// DB 행은 지우지 않는다 — TTS 큐(audio_url IS NULL)·7일 중복제거·히스토리 조회에
// 쓰이는 살아있는 부품이고, 텍스트뿐이라 용량 부담도 없다(전체의 0.1% 미만).
// 대신 파일을 지운 행의 audio_url은 NULL로 되돌린다: 없는 파일을 가리키는 URL을
// 남겨두면 "오디오가 있다"고 거짓말하는 데이터가 된다.
// (getPendingAudioLogs는 최근 3일만 보므로 40일 지난 행을 비워도 재합성되지 않는다)
//
// 실행: node src/local/prune-audio.js [--days=40] [--dry-run]

import { createClient } from '@supabase/supabase-js'
import { config }       from '../../config/index.js'
import { logger }       from '../utils/logger.js'

const days     = parseInt(process.argv.find(a => a.startsWith('--days='))?.split('=')[1] ?? '40', 10)
const isDryRun = process.argv.includes('--dry-run')

async function main() {
  if (!config.supabase.url || !config.supabase.serviceKey) {
    throw new Error('Supabase not configured')
  }
  const sb = createClient(config.supabase.url, config.supabase.serviceKey, {
    auth: { persistSession: false },
  })
  const bucket = config.storage.bucket

  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000)
  logger.info(`[prune-audio] 기준: ${cutoff.toISOString().slice(0, 10)} 이전 (${days}일)${isDryRun ? ' [DRY RUN]' : ''}`)

  // 스토리지를 직접 훑는다 — DB 로그 기준으로 지우면 로그에 없는 고아 파일
  // (구버전·재시도 잔여물)이 영원히 남는다.
  const { data: files, error: listErr } = await sb.storage.from(bucket).list('', { limit: 1000 })
  if (listErr) throw new Error(`list failed: ${listErr.message}`)

  const stale = files.filter(f => f.created_at && new Date(f.created_at) < cutoff)
  if (stale.length === 0) {
    logger.info('[prune-audio] 정리할 파일 없음')
    return
  }

  const bytes = stale.reduce((s, f) => s + (f.metadata?.size ?? 0), 0)
  logger.info(`[prune-audio] 대상 ${stale.length}개 / ${(bytes / 1024 / 1024).toFixed(1)}MB`)

  if (isDryRun) {
    for (const f of stale.slice(0, 5)) logger.info(`  - ${f.name} (${f.created_at.slice(0, 10)})`)
    if (stale.length > 5) logger.info(`  … 외 ${stale.length - 5}개`)
    return
  }

  const names = stale.map(f => f.name)
  const { error: delErr } = await sb.storage.from(bucket).remove(names)
  if (delErr) throw new Error(`remove failed: ${delErr.message}`)
  logger.info(`[prune-audio] 파일 ${names.length}개 삭제`)

  // 지운 파일을 가리키던 로그의 audio_url 비우기 (파일명으로 역매칭)
  let cleared = 0
  for (const name of names) {
    const { data, error } = await sb
      .from('a_briefing_logs')
      .update({ audio_url: null })
      .like('audio_url', `%/${name}`)
      .select('id')
    if (error) { logger.warn(`[prune-audio] audio_url 정리 실패 ${name}: ${error.message}`); continue }
    cleared += (data ?? []).length
  }
  logger.info(`[prune-audio] 완료 — 파일 ${names.length}개 삭제, 로그 ${cleared}건 audio_url 비움`)
}

main()
  .then(() => process.exit(0))
  .catch(err => { logger.error(`[prune-audio] FATAL: ${err.message}`); process.exit(1) })
