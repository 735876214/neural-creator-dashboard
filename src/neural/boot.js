// 页面入口：先确认登录状态、取数据，再挂载 React。
//
// 顺序很关键：数据必须在 src/neural/main.jsx（以及它牵连的 works.js / graph.js）被 import
// 之前就填进 store.js —— 那些模块在顶层就同步地把数据推导成图谱了。
//
// 取数策略分三种情况，避免静态部署时刷出一条没意义的报错：
//   * 设了 VITE_API_BASE  —— 明确是部署模式，取不到就提示（本来就应该取到）
//   * 没设               —— 先安静地试一下同源的 /api/data（开发时的 vite 代理走这条），
//                          取不到就当纯静态站，直接用 my-data.local.js 或示例数据
//
// 登录：note-api 开了登录时，/api/session 会返回 required:true / authenticated:false，
// 这时跳转到独立的 login.html；登录成功后再回到当前页。纯静态模式没有这个接口，直接跳过。
import {setApiData, setError} from '../data/store.js';

const API_BASE = import.meta.env.VITE_API_BASE ?? '';
const EXPECT_API = import.meta.env.VITE_API_BASE !== undefined;
const TIMEOUT = Number(import.meta.env.VITE_API_TIMEOUT || 8000);
const LOGIN_PAGE = (import.meta.env.BASE_URL || '/') + 'login.html';

let redirecting = false;
let authRequired = false;

function redirectToLogin() {
  if (redirecting) return;
  redirecting = true;
  const next = location.pathname + location.search + location.hash;
  location.replace(`${LOGIN_PAGE}?next=${encodeURIComponent(next)}`);
}

// 会话过期后，任何 /api 请求都会 401。在 fetch 这一层统一处理，
// 不用去改 persist.js、Analysis.jsx 里的每一个调用点。
function installAuthRedirect() {
  const original = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const res = await original(input, init);
    try {
      const url = typeof input === 'string' ? input : input?.url || '';
      if (authRequired && res.status === 401 && /(^|\/)api\//.test(url) &&
          !/\/api\/(login|session|logout|auth-check)(\?|$)/.test(url)) redirectToLogin();
    } catch { /* 不影响原请求 */ }
    return res;
  };
}

// 取不到后端时给一条一眼能看懂、会自己消失的提示，而不是白屏
function notice(text) {
  const el = document.createElement('div');
  el.textContent = text;
  el.setAttribute('style',
    'position:fixed;left:50%;transform:translateX(-50%);bottom:14px;z-index:9999;max-width:92vw;' +
    'padding:9px 16px;border-radius:999px;font:13px/1.5 system-ui,-apple-system,"Noto Sans SC",sans-serif;' +
    'color:#e8e2d0;background:rgba(12,14,30,.94);border:1px solid rgba(214,183,110,.35);' +
    'box-shadow:0 6px 24px rgba(0,0,0,.45)');
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 10000);
}

async function fetchJson(path, init) {
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {accept: 'application/json', ...(init?.headers || {})},
    signal: AbortSignal.timeout(TIMEOUT)
  });
  if (!res.ok) {
    const err = new Error(`note-api 返回 HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

async function checkSession() {
  try { return await fetchJson('/api/session'); }
  catch { return null; } // 纯静态站、旧版 note-api、或者接口还没起来
}

async function boot() {
  const session = await checkSession();
  authRequired = !!session?.required;
  if (session?.required && !session.authenticated) {
    redirectToLogin();
    return;
  }

  installAuthRedirect();

  try {
    const json = await fetchJson('/api/data');
    if (!json || !Array.isArray(json.posts)) throw new Error('note-api 返回的数据形状不对');
    setApiData(json);
  } catch (e) {
    if (e.status === 401 && authRequired) { redirectToLogin(); return; }
    setError(e);
    console.warn('[boot] 读不到 note-api，回退到本地数据：', e.message);
    if (EXPECT_API) notice('连不上笔记库，正在用本地数据 · Offline: using bundled data');
  }

  document.getElementById('boot-wait')?.remove();
  await import('./main.jsx');
}

await boot();
