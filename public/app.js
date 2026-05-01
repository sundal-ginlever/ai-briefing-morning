// ── State ──────────────────────────────────────────────────────────────────
let SUPABASE_URL = ''
let SUPABASE_ANON = ''
let token = localStorage.getItem('mb_token')
let currentUser = null

// Fetch config from the backend to get Supabase credentials
async function loadConfig() {
  try {
    const res = await fetch('/api/config')
    const config = await res.json()
    SUPABASE_URL = config.SUPABASE_URL
    SUPABASE_ANON = config.SUPABASE_ANON_KEY
    if (token) showApp()
  } catch (e) {
    console.error('Failed to load configuration', e)
  }
}

// ── Auth ───────────────────────────────────────────────────────────────────
function switchAuthTab(tab) {
  const isLogin = tab === 'login'
  document.getElementById('auth-login').style.display  = isLogin ? '' : 'none'
  document.getElementById('auth-signup').style.display = isLogin ? 'none' : ''
  document.getElementById('tab-login-btn').style.background  = isLogin ? 'var(--accent)' : 'transparent'
  document.getElementById('tab-signup-btn').style.background = isLogin ? 'transparent' : 'var(--accent)'
  document.getElementById('tab-login-btn').style.color  = isLogin ? '#fff' : 'var(--muted)'
  document.getElementById('tab-signup-btn').style.color = isLogin ? 'var(--muted)' : '#fff'
  document.getElementById('auth-err').textContent = ''
}

async function login() {
  const email = document.getElementById('auth-email').value.trim()
  const pass  = document.getElementById('auth-pass').value
  if (!email || !pass) return setAuthErr('이메일과 비밀번호를 입력하세요')
  try {
    const res = await fetch(SUPABASE_URL + '/auth/v1/token?grant_type=password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'apikey': SUPABASE_ANON },
      body: JSON.stringify({ email, password: pass })
    })
    const data = await res.json()
    if (!res.ok) throw new Error(data.error_description || data.msg || '로그인 실패')
    token = data.access_token
    localStorage.setItem('mb_token', token)
    showApp()
  } catch(e) { setAuthErr(e.message) }
}

async function signup() {
  const email = document.getElementById('signup-email').value.trim()
  const pass  = document.getElementById('signup-pass').value
  const pass2 = document.getElementById('signup-pass2').value
  if (!email || !pass) return setAuthErr('이메일과 비밀번호를 입력하세요')
  if (pass.length < 8)  return setAuthErr('비밀번호는 8자 이상이어야 합니다')
  if (pass !== pass2)   return setAuthErr('비밀번호가 일치하지 않습니다')
  try {
    const res = await fetch(SUPABASE_URL + '/auth/v1/signup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'apikey': SUPABASE_ANON },
      body: JSON.stringify({ email, password: pass })
    })
    const data = await res.json()
    if (!res.ok) throw new Error(data.error_description || data.msg || '가입 실패')
    // 이메일 확인이 비활성화된 경우 바로 access_token 반환
    if (data.access_token) {
      token = data.access_token
      localStorage.setItem('mb_token', token)
      showApp()
    } else {
      setAuthErr('', '가입 완료! 이메일 확인 링크를 클릭한 후 로그인하세요.')
      switchAuthTab('login')
    }
  } catch(e) { setAuthErr(e.message) }
}

function setAuthErr(msg, ok) {
  const el = document.getElementById('auth-err')
  el.style.color = ok ? 'var(--green)' : 'var(--red)'
  el.textContent = msg || ok || ''
}

function logout() {
  localStorage.removeItem('mb_token')
  location.reload()
}

// ── App Init ───────────────────────────────────────────────────────────────
async function showApp() {
  document.getElementById('auth-screen').style.display = 'none'
  document.getElementById('app').style.display = 'flex'

  const me = await api('GET', '/api/me')
  if (!me) return
  currentUser = me
  document.getElementById('user-email').textContent = me.email

  loadStats()
  loadLatest()
}

// ── API helper ─────────────────────────────────────────────────────────────
async function api(method, path, body) {
  const opts = {
    method,
    headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' }
  }
  if (body) opts.body = JSON.stringify(body)
  const res = await fetch(path, opts)
  if (res.status === 401) { logout(); return null }
  if (!res.ok) { const d = await res.json(); toast(d.error || 'Error', 'fail'); return null }
  return res.json()
}

// ── Tabs ───────────────────────────────────────────────────────────────────
function showTab(name, el) {
  document.querySelectorAll('[id^=tab-]').forEach(t => t.classList.add('hidden'))
  document.querySelectorAll('nav a').forEach(a => a.classList.remove('active'))
  document.getElementById('tab-' + name).classList.remove('hidden')
  el.classList.add('active')
  if (name === 'settings') loadSettings()
  if (name === 'history')  loadHistory()
}

// ── Home ───────────────────────────────────────────────────────────────────
async function loadStats() {
  const data = await api('GET', '/api/history?limit=60')
  if (!data) return
  const h = data.history
  document.getElementById('stat-total').textContent = h.length
  // 연속 일수 계산
  let streak = 0
  const today = new Date().toISOString().slice(0,10)
  const dates = new Set(h.map(r => r.date))
  let d = new Date()
  while (dates.has(d.toISOString().slice(0,10))) { streak++; d.setDate(d.getDate()-1) }
  document.getElementById('stat-streak').textContent = streak + '일'
}

async function loadLatest() {
  const me = currentUser
  if (!me?.settings) return
  // 스케줄 표시
  const utcH = me.settings.schedule_hour_utc ?? 23
  const kstH = (utcH + 9) % 24
  document.getElementById('stat-schedule').textContent = String(kstH).padStart(2,'0') + ':00'

  const data = await api('GET', '/api/history?limit=1')
  if (!data || data.history.length === 0) return
  const latest = data.history[0]
  document.getElementById('latest-card').style.display = 'block'
  document.getElementById('latest-content').innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
      <span style="font-weight:600">${latest.date}</span>
      <span class="badge badge-green">${latest.llm_provider}</span>
    </div>
    <p style="font-size:14px;color:var(--muted);line-height:1.8;margin-bottom:16px">${latest.script?.slice(0,300)}...</p>
    ${latest.audio_url ? `<audio controls src="${latest.audio_url}"></audio>` : ''}
  `
}

// ── Manual Run ─────────────────────────────────────────────────────────────
async function manualRun() {
  const btn = document.getElementById('run-btn')
  btn.disabled = true
  document.getElementById('run-label').textContent = '실행 중...'
  document.getElementById('run-spin').classList.remove('hidden')
  document.getElementById('run-msg').textContent = ''

  const res = await fetch('/api/run', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + token }
  })

  document.getElementById('run-spin').classList.add('hidden')
  if (res.status === 202) {
    document.getElementById('run-label').textContent = '✓ 진행 중'
    document.getElementById('run-msg').textContent = '브리핑 생성 중입니다. 약 1-2분 후 이메일을 확인하세요.'
    toast('파이프라인 시작됨', 'ok')
    setTimeout(() => {
      document.getElementById('run-label').textContent = '▶ 지금 실행'
      btn.disabled = false
    }, 60000)
  } else {
    const d = await res.json()
    document.getElementById('run-label').textContent = '▶ 지금 실행'
    btn.disabled = false
    toast(d.error || '실행 실패', 'fail')
  }
}

// ── Settings ───────────────────────────────────────────────────────────────
async function loadSettings() {
  const me = await api('GET', '/api/me')
  if (!me) return
  const s = me.settings
  document.getElementById('s-country').value    = s.news_country
  document.getElementById('s-categories').value = s.news_categories?.join(',') ?? ''
  document.getElementById('s-pagesize').value   = s.news_page_size
  document.getElementById('s-llm').value        = s.llm_provider
  document.getElementById('s-model').value      = s.llm_model
  document.getElementById('s-voice').value      = s.tts_voice
  document.getElementById('s-speed').value      = s.tts_speed
  document.getElementById('s-lang').value       = s.briefing_language
  document.getElementById('s-secs').value       = s.briefing_target_secs
  document.getElementById('s-hour').value       = s.schedule_hour_utc
  document.getElementById('s-enabled').checked  = s.schedule_enabled
  document.getElementById('s-email').value      = s.delivery_email ?? ''
}

async function saveSettings() {
  const btn = document.getElementById('save-btn')
  btn.disabled = true
  btn.textContent = '저장 중...'
  const cats = document.getElementById('s-categories').value.split(',').map(c=>c.trim()).filter(Boolean)
  const patch = {
    news_country:          document.getElementById('s-country').value,
    news_categories:       cats,
    news_page_size:        parseInt(document.getElementById('s-pagesize').value),
    llm_provider:          document.getElementById('s-llm').value,
    llm_model:             document.getElementById('s-model').value,
    tts_voice:             document.getElementById('s-voice').value,
    tts_speed:             parseFloat(document.getElementById('s-speed').value),
    briefing_language:     document.getElementById('s-lang').value,
    briefing_target_secs:  parseInt(document.getElementById('s-secs').value),
    schedule_hour_utc:     parseInt(document.getElementById('s-hour').value),
    schedule_enabled:      document.getElementById('s-enabled').checked,
    delivery_email:        document.getElementById('s-email').value || null,
  }
  const res = await api('PUT', '/api/me/settings', patch)
  btn.disabled = false
  btn.textContent = '변경사항 저장'
  if (res) toast('설정이 저장되었습니다', 'ok')
}

// ── History ────────────────────────────────────────────────────────────────
async function loadHistory() {
  const data = await api('GET', '/api/history?limit=30')
  const tbody = document.getElementById('history-body')
  if (!data || data.history.length === 0) {
    tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;padding:32px;color:var(--muted)">아직 브리핑 기록이 없습니다</td></tr>'
    return
  }
  tbody.innerHTML = data.history.map(r => `
    <tr>
      <td style="font-weight:600;white-space:nowrap">${r.date}</td>
      <td class="script-cell">${r.script ?? ''}</td>
      <td><span class="badge badge-green">${r.llm_provider}</span></td>
      <td style="color:var(--muted);white-space:nowrap">${r.duration_ms ? (r.duration_ms/1000).toFixed(1)+'s' : '—'}</td>
      <td>${r.audio_url ? `<audio controls src="${r.audio_url}"></audio>` : '<span style="color:var(--muted)">없음</span>'}</td>
    </tr>
  `).join('')
}

// ── Toast ──────────────────────────────────────────────────────────────────
function toast(msg, type = 'ok') {
  const el = document.getElementById('toast')
  el.textContent = (type === 'ok' ? '✓ ' : '✗ ') + msg
  el.className = 'toast show ' + type
  setTimeout(() => el.classList.remove('show'), 3000)
}

// ── Boot ───────────────────────────────────────────────────────────────────
loadConfig()
