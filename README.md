# Morning Briefing ☀️

매일 아침 뉴스를 자동 수집하고, AI로 60초 브리핑 스크립트를 생성,
음성으로 변환 후 이메일로 발송하는 개인 자동화 서비스입니다.

```
NewsAPI → LLM (스크립트) → TTS (음성) → Supabase Storage → Gmail
                                               ↓
                                      briefing_logs (DB)
                                      user_settings (사용자별 설정)
```

**스케줄**: GitHub Actions (무료, 매 정시 실행)
**서버**: Railway (대시보드 + REST API)
**DB/Storage**: Supabase

---

## 빠른 시작

### 1. 설치

```bash
git clone <your-repo> && cd morning-briefing
npm install
cp .env.example .env   # 값 채우기
```

### 2. 최소 설정으로 로컬 테스트

`.env`에 아래만 설정하면 바로 실행됩니다:

```env
NEWS_API_KEY=...        # newsapi.org 무료 키
OPENAI_API_KEY=...      # platform.openai.com
LLM_PROVIDER=openai
TTS_PROVIDER=none       # 음성 없이 스크립트만
STORAGE_PROVIDER=local  # ./output 폴더에 저장
EMAIL_PROVIDER=none     # 이메일 발송 안 함
```

```bash
node src/pipeline/runner.js --dry-run   # 뉴스만 확인
node src/pipeline/runner.js             # 전체 실행
```

---

## 전체 배포 순서

### Step 1 — Supabase 설정

1. [supabase.com](https://supabase.com) → 새 프로젝트 생성
2. **SQL Editor**에서 순서대로 실행:
   ```
   supabase/migrations/001_create_briefing_logs.sql
   supabase/migrations/002_phase2_users.sql
   ```
3. **Storage** → New bucket → 이름: `briefing-audio`, Public: **OFF**
4. **Authentication → Providers** → Email 활성화
5. (권장) **Authentication → Email Templates** → 확인 메일 커스터마이징
6. **Settings → API**에서 키 복사:
   - `URL` → `SUPABASE_URL`
   - `anon public` → `SUPABASE_ANON_KEY`
   - `service_role` → `SUPABASE_SERVICE_KEY` ⚠️ 서버 전용, 절대 노출 금지

### Step 2 — Gmail 앱 비밀번호

1. Google 계정 → 보안 → 2단계 인증 활성화
2. [앱 비밀번호 생성](https://myaccount.google.com/apppasswords) → "메일" 선택
3. 생성된 16자리 비밀번호를 `SMTP_PASS`에 입력 (공백 포함 그대로)

### Step 3 — Railway 배포

```bash
npm install -g @railway/cli
railway login
railway init       # 새 프로젝트 생성
railway up         # 배포
```

Railway 대시보드 → Variables 탭에서 `.env` 내용 전체 붙여넣기.

배포 후 확인:
```bash
curl https://your-app.railway.app/health
# → {"status":"ok"}
```

### Step 4 — GitHub Actions 스케줄러

1. GitHub 레포 → **Settings → Secrets and variables → Actions**

2. **Secrets** 탭에 추가:

   | Secret | 설명 |
   |--------|------|
   | `NEWS_API_KEY` | newsapi.org |
   | `OPENAI_API_KEY` | OpenAI |
   | `SUPABASE_URL` | Supabase 프로젝트 URL |
   | `SUPABASE_SERVICE_KEY` | service_role 키 |
   | `SUPABASE_ANON_KEY` | anon public 키 |
   | `SMTP_USER` | Gmail 주소 |
   | `SMTP_PASS` | Gmail 앱 비밀번호 |
   | `EMAIL_FROM` | Gmail 주소 |
   | `EMAIL_TO` | 수신 이메일 (폴백용) |

3. **Variables** 탭에 추가 (민감하지 않은 설정):
   ```
   ADMIN_EMAILS=your@email.com
   LLM_PROVIDER=openai
   ```

4. Actions 탭 → **Morning Briefing Scheduler** → **Run workflow** → 수동 테스트

> 스케줄은 매 정시 실행. 사용자별 발송 시각은 대시보드에서 개별 설정.

---

## 대시보드 사용법

Railway 배포 후 `https://your-app.railway.app` 접속.

**첫 가입**: 대시보드에서 이메일/비밀번호로 회원가입
(Supabase Authentication → Email 확인 필요 시 메일 확인 후 로그인)

| 탭 | 기능 |
|----|------|
| 홈 | 통계, 수동 즉시 실행, 최근 브리핑 |
| 설정 | 뉴스 국가/카테고리, LLM 선택, 음성, 스케줄 시각 |
| 히스토리 | 날짜별 스크립트 + 오디오 플레이어 |

---

## LLM 변경

설정 탭에서 변경하거나 `.env`에서:

```env
# OpenAI (기본)
LLM_PROVIDER=openai
OPENAI_MODEL=gpt-4o-mini

# Google Gemini
LLM_PROVIDER=gemini
GEMINI_API_KEY=...
GEMINI_MODEL=gemini-1.5-flash

# Ollama (로컬 무료)
LLM_PROVIDER=ollama
OLLAMA_BASE_URL=http://localhost:11434
OLLAMA_MODEL=llama3.2
```

---

## REST API

모든 엔드포인트는 `Authorization: Bearer <token>` 헤더 필요.

| Method | Path | 설명 |
|--------|------|------|
| GET | `/health` | 헬스체크 |
| GET | `/api/me` | 내 프로필 + 설정 |
| PUT | `/api/me/settings` | 설정 변경 |
| GET | `/api/history` | 브리핑 히스토리 (`?limit=30`) |
| POST | `/api/run` | 즉시 실행 |
| GET | `/api/admin/users` | 전체 사용자 (관리자) |
| POST | `/api/admin/run-all` | 전체 강제 실행 (관리자) |

---

## 프로젝트 구조

```
morning-briefing/
├── config/index.js                  중앙 설정 로더
├── src/
│   ├── index.js                     HTTP 서버 (Railway)
│   ├── api/
│   │   ├── supabase.js              Supabase 싱글턴 클라이언트
│   │   ├── users.js                 사용자 설정 CRUD
│   │   └── router.js                REST API 라우터 (JWT 인증)
│   ├── pipeline/
│   │   ├── runner.js                메인 오케스트레이터 (멀티유저)
│   │   └── news.js                  NewsAPI 수집
│   ├── providers/
│   │   ├── llm.js                   OpenAI / Gemini / Ollama
│   │   ├── tts.js                   TTS 음성 합성
│   │   ├── storage.js               Supabase / 로컬 저장
│   │   ├── email.js                 Gmail SMTP
│   │   └── db.js                    브리핑 로그 저장
│   ├── utils/
│   │   ├── logger.js                구조화 로거
│   │   ├── date.js                  날짜 유틸
│   │   └── retry.js                 지수 백오프 재시도
│   └── web/
│       └── dashboard.js             관리 대시보드 SPA
├── supabase/migrations/
│   ├── 001_create_briefing_logs.sql
│   └── 002_phase2_users.sql
└── .github/workflows/
    └── daily-briefing.yml           GitHub Actions 스케줄러
```

---

## 자주 묻는 질문

**Q. NewsAPI 무료 플랜이면 충분한가요?**
하루 100 요청, 한 번 실행에 카테고리 수만큼 요청합니다. 2개 카테고리면 2 요청.
1인 사용자 기준으로 무료 플랜으로 충분합니다.

**Q. 음성이 이상하면?**
`TTS_VOICE`를 바꿔보세요: `alloy`, `echo`, `nova`, `shimmer`, `onyx`, `coral`.
`TTS_SPEED=0.85`로 더 천천히 말하게 할 수 있습니다.

**Q. 한국어 브리핑을 받으려면?**
설정에서 `BRIEFING_LANGUAGE=Korean`으로 변경.
뉴스는 여전히 `NEWS_COUNTRY=us`를 유지하면 영어 뉴스를 한국어로 요약합니다.
한국 뉴스를 원하면 `NEWS_COUNTRY=kr`로 변경.
