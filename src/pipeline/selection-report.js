// src/pipeline/selection-report.js
// 브리핑 선정 검증 리포트(md) 생성.
// pool-reader가 모은 선정 메타데이터를 사람이 읽기 쉬운 리포트로 변환.

export function buildSelectionReport({ report, articles = [], userId, date, dateLabel }) {
  const userTag = userId ? userId.slice(0, 8) : 'default'
  const lines = []

  lines.push(`# 📋 브리핑 선정 검증 리포트`)
  lines.push('')
  lines.push(`- 날짜: ${dateLabel || date}`)
  lines.push(`- 유저: \`${userTag}\``)
  lines.push(`- 생성: ${new Date().toISOString()}`)
  lines.push('')

  // ── 폴백 경로 (pool 미사용 → 라이브 fetch) ──────────────────────────────
  if (report?.fallback) {
    lines.push(`> ⚠️ **Pool 미사용 — 라이브 폴백 경로로 수집됨**`)
    lines.push(`> 사유: ${report.reason || 'pool 비어있음/조회 실패'}`)
    lines.push(`> 키워드: ${(report.keywords || []).join(', ') || '(없음)'}`)
    lines.push('')
    lines.push(`## 최종 선정 (${articles.length})`)
    articles.forEach((a, i) => lines.push(`${i + 1}. ${a.title} — ${a.source || '?'}`))
    lines.push('')
    lines.push(`> 🚨 Pool 경로가 아니므로 키워드/우선순위 선정 검증이 불가합니다. 수집기(collect) 동작을 점검하세요.`)
    return lines.join('\n')
  }

  const r = report || {}
  const kws = r.keywords || []

  // ── 1. 수집 현황 ────────────────────────────────────────────────────────
  lines.push(`## 1. 수집 현황 (최근 24시간 Pool)`)
  lines.push(`- Pool 전체 기사: **${r.poolTotal ?? 0}개**`)
  lines.push(`- 지난 7일 중복 제외 대상: ${r.excludedDuplicates ?? 0}개`)
  lines.push('')

  // ── 2. 키워드별 Pool 분포 ───────────────────────────────────────────────
  lines.push(`## 2. 키워드별 Pool 매칭 분포`)
  if (kws.length === 0) {
    lines.push(`- (키워드 미설정 — AI 큐레이션만으로 선정)`)
  } else {
    lines.push(``)
    lines.push(`| 키워드 | Pool 내 매칭 수 |`)
    lines.push(`|--------|----------------|`)
    for (const k of kws) {
      const n = r.keywordDistribution?.[k] ?? 0
      lines.push(`| ${k} | ${n}${n === 0 ? ' ⚠️' : ''} |`)
    }
  }
  lines.push('')

  // ── 3. 선정 단계별 결과 ─────────────────────────────────────────────────
  lines.push(`## 3. 선정 로직 단계별 결과`)
  lines.push(`- **1단계 — 키워드 매칭** (우선순위 높음): ${r.stage1Count ?? 0}개 선정`)
  const s2 = r.stage2Count ?? 0
  if (s2 > 0) {
    const method = r.stage2Method === 'ai'
      ? 'AI 큐레이션'
      : (r.stage2Method === 'slice' ? 'AI 실패 → 최신순 slice' : '?')
    lines.push(`- **2단계 — 부족분 폴백**: ${s2}개 (${method}, 후보 ${r.stage2CandidateCount ?? 0}개 중 선별)`)
  } else {
    lines.push(`- **2단계 — 부족분 폴백**: 미실행 (1단계만으로 충족)`)
  }
  lines.push('')

  // ── 4. 최종 선정 기사 (우선순위 순) ─────────────────────────────────────
  lines.push(`## 4. 최종 선정 기사 (우선순위 순)`)
  const sel = r.selected || []
  if (sel.length === 0) {
    lines.push(`- (선정된 기사 없음)`)
  } else {
    sel.forEach((s, i) => {
      let tag
      if (s.selectedBy === 'keyword') {
        tag = `🔑 키워드매칭${s.matched?.length ? ` (${s.matched.join(', ')})` : ''}`
      } else if (s.selectedBy === 'ai-curation') {
        tag = `🤖 AI선정${s.matched?.length ? ` (연관: ${s.matched.join(', ')})` : ''}`
      } else {
        tag = `🤖 slice 폴백`
      }
      lines.push(`${i + 1}. **${s.title}**`)
      lines.push(`   - 출처: ${s.source || '?'} · 선정경로: ${tag}`)
    })
  }
  lines.push('')

  // ── 5. 검증 요약 ────────────────────────────────────────────────────────
  lines.push(`## ✅ 검증 요약`)
  const total   = (r.stage1Count ?? 0) + (r.stage2Count ?? 0)
  const kwRatio = total > 0 ? Math.round((r.stage1Count ?? 0) / total * 100) : 0
  lines.push(`- 키워드 기반 선정 비율: **${kwRatio}%** (${r.stage1Count ?? 0}/${total})`)

  const zeroKws = kws.filter(k => (r.keywordDistribution?.[k] ?? 0) === 0)
  if (zeroKws.length > 0) {
    lines.push(`- ⚠️ Pool에 매칭 0건인 키워드: ${zeroKws.join(', ')} (철자/표기 또는 수집 범위 점검)`)
  }
  if (kws.length > 0 && (r.stage1Count ?? 0) === 0) {
    lines.push(`- 🚨 **키워드 매칭 0건 — 전부 AI 폴백으로 채워짐.** 수집기 키워드 검색 동작 점검 필요`)
  } else if (kwRatio >= 60) {
    lines.push(`- ✓ 키워드 기반 선정이 설계대로 작동 중`)
  } else if (kws.length > 0) {
    lines.push(`- △ 키워드 선정이 일부만 작동 (Pool에 관심 주제 기사가 적을 수 있음)`)
  }

  return lines.join('\n')
}
