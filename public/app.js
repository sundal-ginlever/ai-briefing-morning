// public/app.js
// 공개 페이지 — 피드 주소 안내 + 지난 방송 목록. 인증·설정 기능은 없다
// (설정은 맥미니 대시보드 99_open-board에서 관리).
//
// 소개 문단을 포함한 모든 문구가 KO/EN 토글을 따른다(선택은 localStorage에 유지).

const STRINGS = {
  ko: {
    intro:
      "매일 새벽, 세계가 잠든 사이에도 멈추지 않은 이야기들을 모읍니다. " +
      "인공지능이 그려내는 내일의 지형, 비트코인과 크립토 시장에 드나드는 밀물과 썰물, " +
      "그리고 팔란티어에서 안두릴과 에레보르로 이어지는 피터 틸 사단처럼 조용히 판을 바꾸어 가는 이름들까지. " +
      "흩어진 소식을 한 편의 이야기로 엮어, 당신의 아침에 목소리로 도착합니다.",
    subscribeTitle: "팟캐스트 구독",
    subscribeDesc:  "아래 주소를 팟캐스트 앱에 추가하면 새 방송을 자동으로 받아볼 수 있습니다.",
    copy:           "주소 복사",
    copied:         "복사됨",
    episodesTitle:  "지난 방송",
    loading:        "불러오는 중…",
    empty:          "아직 방송이 없습니다.",
    scriptShow:     "대본 보기",
    scriptHide:     "대본 접기",
    feedError:      "피드 주소를 불러오지 못했습니다",
    listError:      "방송 목록을 불러오지 못했습니다.",
    footer:         "AI가 매일 자동으로 만드는 개인용 브리핑입니다.",
  },
  en: {
    intro:
      "Every dawn, we gather the stories that kept moving while the world slept — " +
      "the shifting landscape drawn by artificial intelligence, the tides running in and out of " +
      "Bitcoin and the wider crypto market, and the quiet names remaking the board, running from " +
      "Palantir through Anduril and Erebor along the Thiel network. " +
      "Scattered headlines, woven into a single narrative, arriving as a voice at the start of your day.",
    subscribeTitle: "Subscribe",
    subscribeDesc:  "Add the address below to your podcast app to receive new episodes automatically.",
    copy:           "Copy address",
    copied:         "Copied",
    episodesTitle:  "Past episodes",
    loading:        "Loading…",
    empty:          "No episodes yet.",
    scriptShow:     "Show transcript",
    scriptHide:     "Hide transcript",
    feedError:      "Could not load the feed address",
    listError:      "Could not load the episode list.",
    footer:         "A personal briefing generated automatically by AI, every day.",
  },
};

let lang = "ko";
let feedUrl = "";
let episodes = null;

function t(key) {
  return STRINGS[lang][key];
}

// 길이는 언어와 무관하게 2m25s 형식으로 고정한다(숫자 표기라 번역이 필요 없다).
function fmtDuration(ms) {
  if (!ms) return "";
  const total = Math.round(ms / 1000);
  return `${Math.floor(total / 60)}m${String(total % 60).padStart(2, "0")}s`;
}

function el(tag, className, text) {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text != null) n.textContent = text;
  return n;
}

function copyFeed() {
  if (!feedUrl) return;
  const btn = document.getElementById("copy-btn");
  const done = () => {
    btn.textContent = t("copied");
    btn.classList.add("copied");
    setTimeout(() => {
      btn.textContent = t("copy");
      btn.classList.remove("copied");
    }, 1600);
  };
  // navigator.clipboard는 보안 컨텍스트에서만 동작하므로 실패 시 수동 선택으로 폴백
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(feedUrl).then(done).catch(selectFallback);
  } else {
    selectFallback();
  }
}

function selectFallback() {
  const input = document.getElementById("feed-url");
  input.focus();
  input.select();
}

function renderEpisodes() {
  const box = document.getElementById("episodes");
  box.textContent = "";

  if (episodes === null) {
    box.appendChild(el("p", "state", t("loading")));
    return;
  }
  if (episodes === false) {
    box.appendChild(el("p", "state", t("listError")));
    return;
  }
  if (!episodes.length) {
    box.appendChild(el("p", "state", t("empty")));
    return;
  }

  for (const item of episodes) {
    const card = el("div", "episode");

    const head = el("div", "ep-head");
    // 날짜는 YYYY-MM-DD 그대로 — 언어별 표기를 만들지 않는다.
    head.appendChild(el("span", "ep-date", item.date));
    head.appendChild(el("span", "ep-dur", fmtDuration(item.durationMs)));
    card.appendChild(head);

    const audio = el("audio");
    audio.controls = true;
    audio.preload = "none";
    audio.src = item.audioUrl;
    card.appendChild(audio);

    if (item.script) {
      const toggle = el("button", "ep-toggle", t("scriptShow"));
      const script = el("div", "ep-script", item.script);
      script.hidden = true;
      toggle.onclick = () => {
        script.hidden = !script.hidden;
        toggle.textContent = script.hidden ? t("scriptShow") : t("scriptHide");
      };
      card.appendChild(toggle);
      card.appendChild(script);
    }

    box.appendChild(card);
  }
}

function applyLang() {
  document.documentElement.lang = lang;
  for (const node of document.querySelectorAll("[data-i18n]")) {
    node.textContent = t(node.dataset.i18n);
  }
  for (const btn of document.querySelectorAll(".lang-toggle button")) {
    btn.classList.toggle("active", btn.dataset.lang === lang);
  }
  if (!feedUrl) document.getElementById("feed-url").value = t("feedError");
  renderEpisodes();
}

function setLang(next) {
  lang = next;
  try { localStorage.setItem("mb_lang", next); } catch { /* 사생활 모드 등 — 무시 */ }
  applyLang();
}

async function load() {
  try {
    const meta = await (await fetch("/api/meta")).json();
    feedUrl = new URL(meta.feedPath, location.origin).href;
    document.getElementById("feed-url").value = feedUrl;
  } catch {
    document.getElementById("feed-url").value = t("feedError");
  }

  try {
    const res = await fetch("/api/history");
    if (!res.ok) throw new Error(res.status);
    episodes = (await res.json()).items;
  } catch {
    episodes = false;
  }
  renderEpisodes();
}

try {
  const saved = localStorage.getItem("mb_lang");
  if (saved === "ko" || saved === "en") lang = saved;
} catch { /* 무시 */ }

document.getElementById("copy-btn").addEventListener("click", copyFeed);
for (const btn of document.querySelectorAll(".lang-toggle button")) {
  btn.addEventListener("click", () => setLang(btn.dataset.lang));
}

applyLang();
load();
