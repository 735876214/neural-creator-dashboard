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
import {setApiData, setError, beginLoad, assertApiPayload} from '../data/store.js';

const API_BASE = import.meta.env.VITE_API_BASE ?? '';
const EXPECT_API = import.meta.env.VITE_API_BASE !== undefined;
const TIMEOUT = Number(import.meta.env.VITE_API_TIMEOUT || 8000);
const LOGIN_PAGE = (import.meta.env.BASE_URL || '/') + 'login.html';

let redirecting = false;
let authRequired = false;
// 收到过 note-api 的 HTTP 响应（哪怕 401/500）就说明这里是部署模式：
// 这条事实不能只靠构建期的 VITE_API_BASE 判断（生产镜像的 npm run build 不传 build-arg）。
let serverSeen = false;

// 哪些状态码才算「note-api 在，只是这次没成功」：401/403（要登录）与 502/503/504（网关后面有东西）。
// 404 一律当纯静态站（GitHub Pages、nginx 静态托管对 /api/session 就是 404），
// 500 也不认（`npm run dev` 没起后端时 vite 代理回的是 500）。
// 以前是「有任何状态码就算见过后端」，静态站于是被挂上「正在后台重试」的横幅并每 20 秒空转，
// 与 AGENTS.md「纯静态模式不要联网」冲突。
const backendStatus = s => s === 401 || s === 403 || s === 502 || s === 503 || s === 504;

// 老浏览器没有 AbortSignal.timeout：直接调用会同步抛 TypeError，被当成网络错误走完全部重试。
// 与 persist.js 里的写法保持同一口径，不支持时就不带 signal。
const timeoutSignal = ms =>
  typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
    ? AbortSignal.timeout(ms) : undefined;

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
  const opts = {...init, headers: {accept: 'application/json', ...(init?.headers || {})}};
  const signal = timeoutSignal(TIMEOUT);
  if (signal) opts.signal = signal;
  const res = await fetch(`${API_BASE}${path}`, opts);
  if (!res.ok) {
    const err = new Error(`note-api 返回 HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

async function checkSession() {
  try { return await fetchJson('/api/session'); }
  catch (e) {
    if (backendStatus(e.status)) serverSeen = true; // 后端在，只是这次没成功
    return null; // 纯静态站、旧版 note-api、或者接口还没起来
  }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// 部署模式下没取到数据：每 20 秒安静地试一次，成功就整页重载（图谱与只读态一起恢复）。
function selfHeal() {
  const timer = setInterval(async () => {
    try {
      const signal = timeoutSignal(8000); // 离线时不要每 20 秒再叠一个永不返回的请求
      const r = await fetch(`${API_BASE}/api/data`, signal
        ? {headers: {accept: 'application/json'}, signal}
        : {headers: {accept: 'application/json'}});
      if (r.ok) { clearInterval(timer); location.reload(); }
    } catch { /* 继续等 */ }
  }, 20_000);
}

async function boot() {
  const session = await checkSession();
  authRequired = !!session?.required;
  if (session?.required && !session.authenticated) {
    redirectToLogin();
    return;
  }

  installAuthRedirect();

  const seq = beginLoad();
  let json = null, lastErr = null;
  // 容器刚起来 / 大库首次 reindex 可能超过一次超时：重试几次再决定回退，
  // 否则用户看到的是「示例数据 + 全只读」，像是笔记库被清空了。
  for (let attempt = 0; attempt < 4 && !json; attempt++) {
    try { json = await fetchJson('/api/data'); }
    catch (e) {
      if (e.status === 401 && authRequired) { redirectToLogin(); return; }
      if (backendStatus(e.status)) serverSeen = true;
      lastErr = e;
      if (e.status && e.status < 500) break; // 401 之外的 4xx 重试没意义
      if (attempt < 3) await sleep(600 * 2 ** attempt);
    }
  }
  try {
    if (!json) throw lastErr || new Error('读不到笔记库');
    // 形状校验（五个数组字段是图谱推导的输入）抽到 store.js 共用：refreshData 那条路径也得过。
    // 校验失败抛的是 status=502 的错，下面 catch 会据此提示并后台自愈，而不是静默退化成「只读演示」。
    setApiData(assertApiPayload(json), seq);
  } catch (e) {
    if (e.status === 401 && authRequired) { redirectToLogin(); return; }
    if (backendStatus(e.status)) serverSeen = true;
    setError(e);
    console.warn('[boot] 读不到 note-api，回退到本地数据：', e.message);
    if (EXPECT_API || serverSeen) {
      notice('连不上笔记库，暂时用本地数据，正在后台重试 · Offline, retrying');
      selfHeal();
    }
  }

  document.getElementById('boot-wait')?.remove();
  await import('./main.jsx');
}

await boot();
