// public/app.js
// 공개 페이지 — 피드 주소 안내 + 지난 방송 목록. 인증·설정 기능은 없다
// (설정은 맥미니 대시보드 99_open-board에서 관리).

let feedUrl = ''

function fmtDuration(ms) {
  if (!ms) return ''
  const total = Math.round(ms / 1000)
  const m = Math.floor(total / 60)
  const s = String(total % 60).padStart(2, '0')
  return `${m}분 ${s}초`
}

function fmtDate(iso) {
  const [y, m, d] = iso.split('-')
  return `${y}년 ${Number(m)}월 ${Number(d)}일`
}

function el(tag, className, text) {
  const n = document.createElement(tag)
  if (className) n.className = className
  if (text != null) n.textContent = text
  return n
}

function copyFeed() {
  if (!feedUrl) return
  const btn = document.getElementById('copy-btn')
  const done = () => {
    btn.textContent = '복사됨'
    btn.classList.add('copied')
    setTimeout(() => { btn.textContent = '주소 복사'; btn.classList.remove('copied') }, 1600)
  }
  // navigator.clipboard는 보안 컨텍스트에서만 동작하므로 실패 시 수동 선택으로 폴백
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(feedUrl).then(done).catch(selectFallback)
  } else {
    selectFallback()
  }
}

function selectFallback() {
  const input = document.getElementById('feed-url')
  input.focus()
  input.select()
}

function renderEpisodes(items) {
  const box = document.getElementById('episodes')
  box.textContent = ''

  if (!items.length) {
    box.appendChild(el('p', 'state', '아직 방송이 없습니다.'))
    return
  }

  for (const item of items) {
    const card = el('div', 'episode')

    const head = el('div', 'ep-head')
    head.appendChild(el('span', 'ep-date', fmtDate(item.date)))
    head.appendChild(el('span', 'ep-dur', fmtDuration(item.durationMs)))
    card.appendChild(head)

    const audio = el('audio')
    audio.controls = true
    audio.preload = 'none'
    audio.src = item.audioUrl
    card.appendChild(audio)

    if (item.script) {
      const toggle = el('button', 'ep-toggle', '대본 보기')
      const script = el('div', 'ep-script', item.script)
      script.hidden = true
      toggle.onclick = () => {
        script.hidden = !script.hidden
        toggle.textContent = script.hidden ? '대본 보기' : '대본 접기'
      }
      card.appendChild(toggle)
      card.appendChild(script)
    }

    box.appendChild(card)
  }
}

async function load() {
  try {
    const meta = await (await fetch('/api/meta')).json()
    feedUrl = new URL(meta.feedPath, location.origin).href
    document.getElementById('feed-url').value = feedUrl
  } catch {
    document.getElementById('feed-url').value = '피드 주소를 불러오지 못했습니다'
  }

  try {
    const res = await fetch('/api/history')
    if (!res.ok) throw new Error(res.status)
    const { items } = await res.json()
    renderEpisodes(items)
  } catch {
    const box = document.getElementById('episodes')
    box.textContent = ''
    box.appendChild(el('p', 'state', '방송 목록을 불러오지 못했습니다.'))
  }
}

document.getElementById('copy-btn').addEventListener('click', copyFeed)

load()
