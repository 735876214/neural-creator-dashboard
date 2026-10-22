// AI 调用层：统一走 OpenAI 兼容的 /chat/completions 与 /embeddings。
//
// 换厂商只改环境变量，不改代码：
//   AI_BASE_URL   默认 https://api.deepseek.com/v1（DeepSeek、通义 DashScope 兼容模式、
//                 Kimi、硅基流动都兼容这个格式；Claude 需要兼容网关）
//   AI_API_KEY    chat 模型的 key（必填才启用 AI）
//   AI_MODEL      默认 chat 模型（各任务可用 AI_MODEL_ASK / AI_MODEL_ANALYZE /
//                 AI_MODEL_IDEAS / AI_MODEL_NEWS 单独覆盖，前端请求也可带 model 临时切换）
//   EMBED_BASE_URL  默认 https://api.cloudflare.com/client/v4（OpenAI 兼容源填对应 base；
//                   DeepSeek 没有 embedding，需要单独配）
//   EMBED_API_KEY / EMBED_MODEL   embedding 用（如 Cloudflare 的 @cf/baai/bge-m3，
//                   每天免费 10,000 Neurons；或硅基流动 BAAI/bge-m3）
//   EMBED_PROTOCOL  openai（默认）/ cloudflare（Workers AI 原生，需 CF_ACCOUNT_ID）/ gemini（Google Gemini）
//                  留空时按 EMBED_BASE_URL 与 EMBED_MODEL 自动识别（googleapis.com 或 text-embedding-* 即 gemini）
//   EMBED_DIM       可选：Gemini 的 outputDimensionality（128-3072，Gemini 只有它支持截断维度）
//
// 协议由 AI_PROTOCOL 选择：
//   openai    （默认）OpenAI 兼容 /chat/completions —— DeepSeek、通义、Kimi、硅基流动，
//             以及自建网关
//   anthropic Anthropic /v1/messages —— Claude 官方、智谱 / Kimi / MiniMax 的 Anthropic 端点，
//             以及 CC Switch 这类本地代理（复用 VS Code / Claude Code 已有的账号与额度）
//
// 护栏：超时、限次重试、并发闸、JSON 输出解析兜底、思考型模型（content 空、只有
// reasoning_content）的文本兜底。key 只在服务端，绝不进前端。
const PROTOCOL = (process.env.AI_PROTOCOL || 'openai').toLowerCase();
// 运行时可变：设置面板保存的 AI_BASE_URL / AI_API_KEY / aiModel 会覆盖这里的 env 缺省（setAiRuntime）。
// 接口地址与 key 存 NAS 数据目录，key 绝不回显、不进笔记库；模型选择存 vault settings。
const CHAT_BASE_DEFAULT = 'https://api.deepseek.com/v1';
let CHAT_BASE = (process.env.AI_BASE_URL || CHAT_BASE_DEFAULT).replace(/\/+$/, '');
let CHAT_KEY = process.env.AI_API_KEY || '';
let CHAT_MODEL = process.env.AI_MODEL || 'deepseek-chat';

// 设置面板保存后即时生效：覆盖 baseUrl / key / 全局默认模型。
// 传 '' 恢复 env 缺省（key 恢复 = AI_API_KEY，可能为空即禁用）；null 忽略该项。
let modelCacheRef = null; // 由下方 modelCache 声明回填
export function setAiRuntime({baseUrl, apiKey, model} = {}) {
  if (baseUrl != null) CHAT_BASE = String(baseUrl).trim() ? String(baseUrl).trim().replace(/\/+$/, '') : (process.env.AI_BASE_URL || CHAT_BASE_DEFAULT).replace(/\/+$/, '');
  if (apiKey != null) CHAT_KEY = String(apiKey).trim() ? String(apiKey) : (process.env.AI_API_KEY || '');
  if (model != null) CHAT_MODEL = String(model).trim() || (process.env.AI_MODEL || 'deepseek-chat');
  if (modelCacheRef) modelCacheRef.at = 0; // base/key/model 变更后强制重拉模型列表
}
// 各任务的默认模型：缺省回落 AI_MODEL
const TASK_ENV = {ask: 'AI_MODEL_ASK', analyze: 'AI_MODEL_ANALYZE', ideas: 'AI_MODEL_IDEAS', news: 'AI_MODEL_NEWS', web: 'AI_MODEL_WEB'};
// 任务级模型：env 显式设置优先；未设则跟随运行时全局模型（设置面板可改）
export const taskModel = task => process.env[TASK_ENV[task]] || CHAT_MODEL;
// 兼容旧引用（/api/ai/models 的 taskModels 字段）。JSON 响应需要普通对象：
// Proxy 的 ownKeys 对 JSON.stringify 不生效（序列化结果是 {}），所以这里显式物化。
export const TASK_MODELS = new Proxy({}, {get: (_, task) => taskModel(task), has: (_, task) => task in TASK_ENV, ownKeys: () => Object.keys(TASK_ENV)});
export const taskModelsSnapshot = () => Object.fromEntries(Object.keys(TASK_ENV).map(t => [t, taskModel(t)]));
const EMBED_BASE_ENV = process.env.EMBED_BASE_URL || '';
const EMBED_KEY_ENV = process.env.EMBED_API_KEY || '';
const EMBED_MODEL = process.env.EMBED_MODEL || '';
// Gemini 的 OpenAI 兼容层不提供 embedding，只能走它自己的 REST：
//   POST {base}/{model}:batchEmbedContents（batch）或 :embedContent（单条），key 走 x-goog-api-key。
const GEMINI_BASE_DEFAULT = 'https://generativelanguage.googleapis.com/v1beta';
const EMBED_DIM = Number(process.env.EMBED_DIM) || 0;
// 协议三级判定：显式 EMBED_PROTOCOL > 地址/模型名自动识别 > 默认 openai。
// 自动识别很重要：用户照文档只填了 Google 的地址和模型，不该因为漏写 EMBED_PROTOCOL 就得到一个
// 「/embeddings 不存在（404）」——那条报错会把人引向「换网关」，而真正要改的只是协议。
export function embedProtocol() {
  const env = (process.env.EMBED_PROTOCOL || '').toLowerCase();
  if (env) return env;
  const base = EMBED_BASE_ENV.toLowerCase(), model = EMBED_MODEL.toLowerCase();
  // 只有「Google 的地址」或「gemini-embedding 系列」才算 Gemini。
  // 曾经把 `text-embedding-` 前缀也算进来，结果阿里 DashScope 的 text-embedding-v3
  // 被误判成 Gemini，请求打到 googleapis 得到 404「找不到这个模型」——模型名是各家都会撞的，
  // 不能单独作为判据（地址才是）。
  if (/googleapis\.com/.test(base) || /^(models\/)?gemini-embedding/.test(model)) return 'gemini';
  if (/cloudflare\.com/.test(base)) return 'cloudflare';
  return 'openai';
}
// 同理：AI_TIMEOUT=0 会让 AbortSignal.timeout(0) 每次调用 1ms 内必超时，所有 AI 都报「请求超时」。
const TIMEOUT = Math.max(5_000, Number(process.env.AI_TIMEOUT) || 60_000);

// anthropic 模式下 CHAT_BASE 有非空默认值，光看「base 非空」会让「没配 key」被当成「AI 可用」：
// 前端照样渲染 AI 按钮，请求打到默认网关拿 401，提示却指向「检查 API Key」，方向完全误导。
export const aiEnabled = () => PROTOCOL === 'anthropic'
  ? (!!CHAT_KEY || CHAT_BASE !== CHAT_BASE_DEFAULT) // 显式给了 key 或自定义了网关，才算启用
  : !!CHAT_KEY;
// Gemini 的 key 与 chat 的 key 是两套凭据（Google AI Studio 的 key 打不了 DeepSeek），
// 所以 gemini 协议下不能像 openai 那样回落到 CHAT_KEY：那会让「没配 key」变成「每次调用 403」。
export const embedEnabled = () => !!(embedProtocol() === 'gemini' ? EMBED_KEY_ENV : (EMBED_KEY_ENV || CHAT_KEY)) && !!EMBED_MODEL;
export const aiInfo = () => ({
  enabled: aiEnabled(), model: CHAT_MODEL, protocol: PROTOCOL,
  taskModels: taskModelsSnapshot(),
  // 启用分支必须带 enabled: true —— 前端只认 aiInfo.embed.enabled，
  // 少这个字段会让「语义关联」按钮与设置面板提示永远不渲染（relate 从 UI 上完全不可达）。
  embed: embedEnabled()
    ? {enabled: true, model: EMBED_MODEL, protocol: embedProtocol(), dim: EMBED_DIM || null,
      // gemini 有自己的默认地址，不能拿它跟 chat 的 base 比「同源」
      sameBase: embedProtocol() !== 'gemini' && (EMBED_BASE_ENV || CHAT_BASE) === CHAT_BASE}
    : {enabled: false, protocol: embedProtocol(), model: EMBED_MODEL || null}
});

// —— 模型列表（前端下拉用）：/v1/models，缓存 10 分钟 ——
// ok 记录这次列表是不是真从网关拿到了：拉取失败时只塞一个默认模型，此时不能拿它当白名单
// 去否决用户已保存的模型（否则一次 8s 超时会把打标签/选题/问答连挂 10 分钟，重试也不好）。
const modelCache = {at: 0, ok: false, list: []};

// 模型返回的摘要/要点可能带换行：frontmatter 是逐行 YAML，多行值会把笔记属性写坏，
// 所以在落库前就折叠成单行（yamlString 也会转义，但单行更可读）。
const oneLine = v => String(v ?? '').replace(/\s+/g, ' ').trim();
// 模型「回的是合法 JSON、但字段形状不对」比非 JSON 更常见（tags 给了字符串、ideas 给了对象）。
// 直接 (out.tags || []).map 会在字符串/对象上抛 TypeError，整批任务当场 error、后面一条都不再处理；
// 统一先用这两个助手归一化，错形状降级成空数组/空串，最坏也只是这一篇没有标签。
const asArray = v => (Array.isArray(v) ? v : []);
// 模型还会把键名翻成中文（实测 glm-5.3-flash 把 ideas/title 写成 选题/标题），
// 只认英文键时整批结果会静默变成空数组（接口 200 但一条候选都没有）。
// 取值统一走这里：先试英文键，再按规范化后的键名比中文别名。
export const pickKey = (obj, ...keys) => {
  if (!obj || typeof obj !== 'object') return undefined;
  for (const k of keys) if (obj[k] != null) return obj[k];
  const norm = s => String(s).replace(/[\s_"'#]/g, '').toLowerCase();
  const map = new Map(Object.entries(obj).map(([k, v]) => [norm(k), v]));
  for (const k of keys) { const v = map.get(norm(k)); if (v != null) return v; }
  return undefined;
};
// 拿「列表」：模型换键名（ideas / 选题 / topics / candidates）很常见，甚至把数组塞在
// 一个完全没要求过的键下面（实测 glm-5.3-flash 回 {"topics":[{title,angle,description}]}）。
// 先按提示键找数组，再退化成「对象里第一个数组值」，最后接受顶层数组本身。
// 对象里最长的一段字符串（跳过指定键），用于「摘要/理由」这类没有固定键名的字段兜底
export function longestStr(obj, skip = []) {
  if (!obj || typeof obj !== 'object') return '';
  const skipSet = new Set(skip.map(k => String(k)));
  return Object.entries(obj)
    .filter(([k, v]) => typeof v === 'string' && !skipSet.has(k) && !skipSet.has(pickKeyNameAlias(k)))
    .map(([, v]) => v).sort((a, b) => b.length - a.length)[0] || '';
}
const pickKeyNameAlias = k => ({'标题': 'title', 'title': 'title', '平台': 'platform', 'platform': 'platform',
  '优先级': 'priority', 'priority': 'priority', '角度': 'angle', 'angle': 'angle'}[k] || k);

// 对象/数组里任意一个「字符串数组」，用于「依据的热点标题」这类字段兜底
export function firstStrList(obj) {
  if (!obj || typeof obj !== 'object') return [];
  for (const v of Object.values(obj)) {
    if (Array.isArray(v) && v.length && v.every(x => typeof x === 'string')) return v;
  }
  return [];
}

// 主题可能是数组，也可能是 {"主题名": ["标题", …]} 这种对象映射
export function topicEntries(v) {
  if (Array.isArray(v)) return v.filter(t => t && typeof t === 'object');
  if (v && typeof v === 'object') {
    return Object.entries(v).filter(([, titles]) => Array.isArray(titles))
      .map(([name, titles]) => ({name, titles}));
  }
  return [];
}

export function pickList(obj, hints) {
  if (Array.isArray(obj)) return obj;
  if (!obj || typeof obj !== 'object') return [];
  const hit = pickKey(obj, ...(hints || []));
  if (Array.isArray(hit)) return hit;
  for (const v of Object.values(obj)) if (Array.isArray(v)) return v;
  return [];
}
const asText = v => (typeof v === 'string' ? v : '');
modelCacheRef = modelCache;
export async function listModels() {
  if (Date.now() - modelCache.at < 10 * 60_000) return modelCache.list;
  try {
    // anthropic 模式的 /models 也要换头和路径：Anthropic 官方是 GET /v1/models + x-api-key，
    // 拿 openai 的 Bearer 打过去只会 401，设置面板就永远只显示一个默认模型。
    const base = PROTOCOL === 'anthropic' ? CHAT_BASE.replace(/\/+v1$/i, '') : CHAT_BASE;
    const path = PROTOCOL === 'anthropic' ? '/v1/models' : '/models';
    const headers = PROTOCOL === 'anthropic'
      ? {'x-api-key': CHAT_KEY, 'anthropic-version': process.env.ANTHROPIC_VERSION || '2023-06-01'}
      : {authorization: `Bearer ${CHAT_KEY}`};
    const res = await fetch(base + path, {headers, signal: AbortSignal.timeout(8000)});
    // 404 不是「坏了」而是「这个网关没有模型列表接口」：要在日志里说清楚，否则用户只会
    // 看到面板里只剩一个默认模型，以为模型全都拉不到。
    if (!res.ok) throw new Error(`HTTP ${res.status}${res.status === 404 ? '（该网关没有 /models 接口，请在设置里手动填模型名）' : ''}`);
    const j = await res.json();
    modelCache.at = Date.now();
    modelCache.ok = true;
    modelCache.list = (j.data || []).map(m => ({
      id: m.id, name: m.name || m.id,
      reasoning: !!(m.only_reasoning || m.reasoning_supported || /reasoning/i.test(String(m.tags || '')))
    }));
  } catch (e) {
    if (!modelCache.list.length || !modelCache.ok) console.error('[ai] 拉取模型列表失败：', e.message);
    // 失败不写 at：写了就把它钉在缓存里 10 分钟，重试也不会重拉。
    // 从来没有成功过就只放默认模型应急，并标记 ok=false，让 validModel 不做白名单拒绝。
    modelCache.ok = false;
    if (!modelCache.list.length) modelCache.list = [{id: CHAT_MODEL, name: CHAT_MODEL, reasoning: false}];
  }
  return modelCache.list;
}
export async function validModel(id) {
  if (!id) return false;
  const list = await listModels();
  // 列表不可信（从没成功拉到过）时不做白名单拒绝：宁可让上游回一个明确错误，
  // 也不要把用户自己填的模型判成「未知模型」400 且持续 10 分钟。
  if (!modelCache.ok) return true;
  return list.some(m => m.id === id);
}

// 并发闸：AI 供应商普遍有 RPM 限制，个人自用限到 4 足够，也保护 NAS 的内存。
let active = 0;
const waiters = [];
// 数字型 env 必须兜底：AI_CONCURRENCY=0（用户以为「0=不限」）或写错成 "4 并发" 时，
// Number() 得到 0 / NaN，`active < MAX_CONCURRENT` 恒为 false —— 每个调用都永久停在 waiters 里
// （没有超时也没有报错），还会连带占死 runJob 的全局单飞闸，AI / 日报 / 同步 / 发布全部 409，
// 只能重启容器。凡是从环境变量读来的数字都得这么兜一层。
const MAX_CONCURRENT = Math.max(1, Math.floor(Number(process.env.AI_CONCURRENCY)) || 4);
async function gate() {
  if (active < MAX_CONCURRENT) { active++; return; }
  await new Promise(r => waiters.push(r));
  active++;
}
const release = () => { active--; waiters.shift()?.(); };

// —— 任务取消 ——
// 慢网关上一个 AI 任务能耗掉几分钟，而全局单飞闸只有一个：期间所有 AI / 日报 / 平台同步
// 全是 409，用户除了等超时或重启容器没有别的办法。runJob 开始时装一个 AbortController，
// 取消时 abort()，正在跑的 fetch 立刻中断；call() 把它的信号和自己的单次超时合成一个。
let activeCtrl = null;
export function beginJobCancel() { activeCtrl = new AbortController(); return activeCtrl; }
export function endJobCancel(ctrl) { if (activeCtrl === ctrl) activeCtrl = null; }
export function cancelJob() {
  if (!activeCtrl || activeCtrl.signal.aborted) return false;
  activeCtrl.abort();
  return true;
}
export const jobAborted = () => !!(activeCtrl && activeCtrl.signal.aborted);
// 取消抛的错误必须致命（fatal）：analyze 的逐篇 try/catch 只跳过「这一篇失败」，
// 不标 fatal 的话用户点了取消，任务还会继续跑完剩下的每一篇。
export const abortError = () => Object.assign(new Error('任务已取消'), {fatal: true});
export function assertNotAborted() { if (jobAborted()) throw abortError(); }
const jobSignal = () => (activeCtrl ? activeCtrl.signal : null);
// 合成「本次调用超时」与「任务取消」两个信号；AbortSignal.any 需要 Node 20+（本项目要求 20.19+）。
const withJob = sig => { const j = jobSignal(); return j ? AbortSignal.any([sig, j]) : sig; };

// 把上游状态码翻译成用户能照着改的说法：对外只回这一句（原文只进服务端日志）。
function upstreamError(status) {
  if (status === 401 || status === 403) return `AI 接口鉴权失败（${status}）：检查 API Key 是否有效、该 Key 是否有这个模型的权限`;
  if (status === 404) return 'AI 接口地址或模型不存在（404）：检查 Base URL 是否以 /v1 结尾、模型名是否在 /v1/models 列表里';
  if (status === 400 || status === 422) return `AI 请求被上游拒绝（${status}）：模型名或参数不被接受，换模型或检查 max_tokens`;
  if (status === 429) return 'AI 接口限流（429）：稍后重试，或调低 AI_CONCURRENCY';
  if (status === 413) return 'AI 请求过长（413）：把这批内容拆小一点再分析';
  if (status >= 500) return `AI 上游错误（${status}）：稍后重试，若持续出现请看服务端日志`;
  return `AI 接口错误（${status}）`;
}

// fetch 抛出来的错误只有顶层一句「fetch failed」，真正原因在 cause.code 里。
// 认不出网络原因时返回 ''（交给上层原样抛，别把模型层的正常错误也盖成「连不上」）。
function netReason(e) {
  const code = e?.cause?.code || e?.code || '';
  const map = {
    ECONNREFUSED: '连接被拒绝', ENOTFOUND: '域名解析失败', EAI_AGAIN: '域名解析超时',
    ETIMEDOUT: '建立连接超时', EHOSTUNREACH: '主机不可达', ENETUNREACH: '网络不可达',
    ECONNRESET: '连接被重置', UND_ERR_CONNECT_TIMEOUT: '建立连接超时',
    DEPTH_ZERO_SELF_SIGNED_CERT: '证书不受信任', UNABLE_TO_VERIFY_LEAF_SIGNATURE: '证书链不完整',
    CERT_HAS_EXPIRED: '证书已过期', ERR_TLS_CERT_ALTNAME_INVALID: '证书域名不匹配'
  };
  if (code && map[code]) return `${map[code]} ${code}`;
  const msg = String(e?.message || '');
  if (/fetch failed|socket hang up|other side closed/i.test(msg)) return code || '网络错误';
  return '';
}

async function call(base, key, path, payload, extraHeaders = {}) {
  assertNotAborted();
  await gate();
  assertNotAborted();
  try {
    for (let attempt = 0; ; attempt++) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), TIMEOUT);
      try {
        const res = await fetch(base + path, {
          method: 'POST',
          headers: {'content-type': 'application/json', authorization: `Bearer ${key}`, ...extraHeaders},
          body: JSON.stringify(payload), signal: withJob(ctrl.signal)
        });
        if ((res.status === 429 || res.status >= 500) && attempt < 2) {
          await new Promise(r => setTimeout(r, 1000 * 2 ** attempt));
          continue;
        }
        if (!res.ok) {
          const text = await res.text().catch(() => '');
          // 上游错误体常带渠道 / 配额 / 上游账号等内部细节，而这条消息会进 job.error，
          // 由 /api/ai/jobs 回给浏览器并长期留在 SQLite：原文只写服务端日志，对外给状态码 + 分类原因。
          console.error(`[ai] 上游返回 ${res.status}：${text.slice(0, 400)}`);
          // 4xx 是确定性失败（key 失效、模型不存在、参数不合法）：重试只会把一次失败放大成三次，
          // 在 relate 这种「每条一次调用」的循环里等于任务长时间无进展。标成 fatal 直接抛。
          const err = new Error(upstreamError(res.status));
          err.fatal = res.status < 500 && res.status !== 429;
          // 原始错误体只给程序用（例如 embedding 的「batch size 不能大于 10」要靠它识别并二分重试），
          // 对外消息里仍然只有分类原因，避免把渠道 / 上游账号细节漏给浏览器。
          err.upstreamStatus = res.status;
          err.upstreamBody = text.slice(0, 600);
          throw err;
        }
        return await res.json();
      } catch (e) {
        if (e.name === 'AbortError') {
          // 区分「自己超时」和「用户取消」：取消是确定性终止，抛 fatal 让上层循环立刻收手。
          if (jobAborted()) throw abortError();
          throw new Error('AI 请求超时（' + TIMEOUT / 1000 + 's）');
        }
        if (e.fatal) throw e;
        if (attempt >= 2) {
          // 网络层失败（DNS 解析不了 / 连接被拒 / 证书 / 代理断）原来原样抛出 fetch failed，
          // 上层只看得到「服务器内部错误」——用户不知道该去改接口地址、还是该查 NAS 的外网。
          // 这类错误的 cause 是真正原因（ECONNREFUSED / ENOTFOUND …），翻成一句话再说。
          const net = netReason(e);
          if (net) throw new Error(`AI 接口连不上（${net}）：检查 AI 接口地址（含端口与 /v1 前缀）在 NAS 上是否可达、DNS 与代理是否正常`);
          throw e;
        }
        await new Promise(r => setTimeout(r, 1000 * 2 ** attempt));
      } finally { clearTimeout(timer); }
    }
  } finally { release(); }
}

// 从 OpenAI 格式回复里取正文。只认 content，**不兜底 reasoning_content**：
// 思考型模型的推理过程和正文共用 max_tokens，预算被思考吃光时 content 是空串，
// 把 reasoning 当答案会把英文内心独白直接投给用户（实测 cn:auto 会把
// \"We need answer in Chinese. User asks: ...\" 当回答返回）。空正文交给 chat() 重试。
function contentOf(msg) {
  if (!msg) return null;
  let c = msg.content;
  if (Array.isArray(c)) c = c.filter(b => b.type === 'text').map(b => b.text).join('');
  return typeof c === 'string' && c.trim() ? c : null;
}

// 从回复里抠出 JSON：模型经常给「```json … ```」包裹，或在 JSON 后面补一句
// 「（来源见 [1]）」——原来的贪婪正则 /[[{][\s\S]*[\]}]/ 会把后面的 [1] 一起吃进去，
// 于是合法 JSON 也被判成不合法。改成：先试整体、再试代码块，最后按括号配对截取。
function parseJson(text) {
  const s = String(text ?? '');
  try { return JSON.parse(s); } catch {}
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) { try { return JSON.parse(fence[1]); } catch {} }
  for (const [open, close] of [['{', '}'], ['[', ']']]) {
    const start = s.indexOf(open);
    if (start < 0) continue;
    let depth = 0, inStr = false, esc = false;
    for (let i = start; i < s.length; i++) {
      const ch = s[i];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === '\\') esc = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') inStr = true;
      else if (ch === open) depth++;
      else if (ch === close && --depth === 0) {
        try { return JSON.parse(s.slice(start, i + 1)); } catch { break; }
      }
    }
  }
  throw new Error('AI 没有返回合法 JSON（常见原因：回复是散文或正文被 max_tokens 截断）：' + s.slice(0, 160));
}

// 要严格 JSON 时走 response_format，供应商不支持时靠正则从回复里抠。
const JSON_REPAIR = '上面的回复不是合法 JSON。请只输出一个 JSON 对象本身：不要解释、不要 Markdown 代码块、不要任何额外文字。字段名必须与我上面指定的一模一样（英文键名），不要翻译成中文。';
// 模型无视 response_format、直接把 JSON 指令写成文章是常态（实测 glm-5.3-flash 会输出一篇
// 带标题的「选题清单」散文）。此时把它的回复作为 assistant 回填、再要一次严格 JSON 比
// 直接失败划算：多一次调用，换来打标签 / 选题 / 日报整条链路不至于整批报错。
async function jsonWithRepair(text, resend) {
  try { return parseJson(text); } catch (e) {
    const fixed = await resend(text);
    if (fixed) { try { return parseJson(fixed); } catch {} }
    throw e;
  }
}
export async function chat(messages, {json = false, temperature = 0.3, maxTokens = 1500, model} = {}) {
  if (!aiEnabled()) throw new Error('AI 未启用：请设置 AI_API_KEY（或 Anthropic 模式下的 AI_BASE_URL）');
  const useModel = model || CHAT_MODEL;
  if (PROTOCOL === 'anthropic') {
    // Anthropic /v1/messages：system 单独传，消息只收 user/assistant；
    // 回复可能是 [text, thinking, ...] 块数组，拼接所有 text 块。
    const sys = messages.filter(m => m.role === 'system').map(m => m.content).join('\n');
    const rest = messages.filter(m => m.role !== 'system');
    const payload = {model: useModel, max_tokens: maxTokens, temperature, messages: rest};
    if (sys) payload.system = sys;
    const send = body => call(CHAT_BASE.replace(/\/+v1$/i, ''), CHAT_KEY, '/v1/messages', body, {
      // Anthropic 官方要 anthropic-version + x-api-key；路径自带 /v1，base 不能以 /v1 结尾
      // （否则拼成 /v1/v1/messages → 404）。CC Switch 这类代理同样认这两个头。
      'x-api-key': CHAT_KEY,
      'anthropic-version': process.env.ANTHROPIC_VERSION || '2023-06-01'
    });
    const data = await send(payload);
    const text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
    if (!text) throw new Error('AI 返回了空回复（可能全是 thinking 块），换个措辞再试');
    if (!json) return text;
    return jsonWithRepair(text, async raw => {
      const fix = await send({...payload, messages: [...rest, {role: 'assistant', content: String(raw).slice(0, 6000)}, {role: 'user', content: JSON_REPAIR}], temperature: 0});
      return (fix.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
    });
  }
  const payload = {model: useModel, messages, temperature, max_tokens: maxTokens};
  if (json) payload.response_format = {type: 'json_object'};
  const t0 = Date.now();
  let data = await call(CHAT_BASE, CHAT_KEY, '/chat/completions', payload);
  let text = contentOf(data.choices?.[0]?.message);
  if (!text) {
    // 空正文有两种原因，处理方式相反：
    // ① 预算被推理吃光（回复很快，模型还想继续说）→ 放宽预算重试一次即可；
    // ② 模型本身就是纯思考型（回复很慢、等到超时才有 reasoning）→ 再重试只是让用户多等一个超时，
    //    直接报错更诚实。用「第一次的耗时」区分：慢的就不再重试。
    const elapsed = Date.now() - t0;
    const big = Math.min(Math.max(maxTokens * 4, 4000), 32000);
    const hint = '换个模型（如 cn:deepseek-v4.1-flash）或调大 max_tokens';
    if (elapsed < 20000) {
      data = await call(CHAT_BASE, CHAT_KEY, '/chat/completions', {...payload, max_tokens: big});
      text = contentOf(data.choices?.[0]?.message);
      if (!text) throw new Error('AI 只返回了思考过程，没有正文（' + useModel + ' 的推理占满了 ' + big + ' tokens）：' + hint);
    } else {
      throw new Error('AI 只返回了思考过程，没有正文（' + useModel + ' 花了 ' + Math.round(elapsed / 1000) + ' 秒仍在推理）：' + hint);
    }
  }
  if (!json) return text;
  return jsonWithRepair(text, async raw => {
    const fix = await call(CHAT_BASE, CHAT_KEY, '/chat/completions', {
      ...payload,
      messages: [...messages, {role: 'assistant', content: String(raw).slice(0, 6000)}, {role: 'user', content: JSON_REPAIR}],
      temperature: 0
    });
    return contentOf(fix.choices?.[0]?.message) || '';
  });
}

// 向量形状校验：空向量 / 非数值 / 维度不一致都要当场报错（配一句能照做的说明）。
function checkVecs(rows) {
  if (!Array.isArray(rows) || !rows.length) throw new Error('embedding 返回空结果：检查 EMBED_MODEL 是否是 embedding 模型（chat 模型不返回向量）');
  const dim = Array.isArray(rows[0]) ? rows[0].length : 0;
  if (!dim) throw new Error('embedding 返回的不是向量（第 1 条为空或不是数组）：检查 EMBED_MODEL 是否为 embedding 模型');
  for (let i = 0; i < rows.length; i++) {
    const v = rows[i];
    if (!Array.isArray(v) || !v.length) throw new Error(`embedding 第 ${i + 1} 条不是有效向量：接口返回结构异常`);
    if (v.length !== dim) {
      throw new Error(`embedding 向量维度不一致（第 1 条 ${dim} 维，第 ${i + 1} 条 ${v.length} 维）：`
        + '同一 EMBED_MODEL 名下接口换了向量维度。旧向量已混进索引，请换个 EMBED_MODEL 名称（或清空 DATA_DIR 的 index.sqlite 里的 embeddings）后重跑「AI 语义关联」');
    }
    for (let k = 0; k < v.length; k++) {
      if (!Number.isFinite(v[k])) throw new Error(`embedding 第 ${i + 1} 条含非法数值（NaN/Infinity）：换一个 embedding 模型再试`);
    }
  }
}

// Gemini embedding 的错误翻译：它的 400/403 文案是给 GCP 用户看的（"API key not valid"、
// "Generative Language API has not been used in project … or it is disabled"），
// 直接抛给看板用户等于没说；这里统一翻成「改哪个变量」。
function geminiEmbedError(status, raw) {
  const body = String(raw || '').slice(0, 400);
  if (/API key not valid|API_KEY_INVALID/i.test(body)) return 'Gemini 的 API key 无效（' + status + '）：检查 EMBED_API_KEY 是否复制完整、是否已被吊销';
  // 403 有两种完全不同的原因，混在一起会把用户引向「改 key」，而真正要改的是出口：
  //   ① key 无效 → 401 API key not valid（上面那条）
  //   ② key 有效但被拒 → "project has been denied access" / "User location is not supported"
  //      —— 实测这是**出口 IP 的地区/机房属性**被 Google 拒（同一把 key 换住宅节点就能通），
  //      也可能是该 Google Cloud 项目被封禁。这两种都不该让人去重抄 key。
  if (/denied access|location is not supported|FAILED_PRECONDITION/i.test(body)) {
    return 'Gemini 拒绝了这个出口（' + status + '）：key 本身是有效的（无效 key 会报 401 API key not valid），'
      + '但当前出口 IP 所在地区/机房被 Google 拒绝，或该 Cloud 项目被封禁。'
      + '换一个受支持地区的节点（住宅/非机房 IP）后重试，或改用硅基流动等 OpenAI 兼容方案；' + body;
  }
  if (status === 403) return 'Gemini 拒绝了这个 key（403）：在 Google AI Studio 确认 key 有效且已启用 Generative Language API；' + body;
  if (status === 404) return 'Gemini 找不到这个 embedding 模型（404）：EMBED_MODEL 用 gemini-embedding-001 或 text-embedding-004（带不带 models/ 前缀都行）';
  if (status === 429) return 'Gemini embedding 触发限流（429）：免费额度用完了，等一会儿或换 key';
  if (status === 400 && /dimension/i.test(body)) return 'Gemini 不接受这个维度：EMBED_DIM 只在 gemini-embedding-001 上生效（128-3072），text-embedding-004 固定 768 维，删掉 EMBED_DIM 再试；' + body;
  if (status >= 500) return 'Gemini embedding 上游故障（' + status + '）：稍后重试';
  return 'Gemini embedding 返回 ' + status + '：' + body;
}

// type 决定 Gemini 的 taskType：文档入库用 RETRIEVAL_DOCUMENT，检索查询用 RETRIEVAL_QUERY。
// 两者是不同向量空间，混用会明显掉召回；openai / cloudflare 协议忽略这个参数。
export async function embed(texts, {type = 'document'} = {}) {
  if (!embedEnabled()) throw new Error('embedding 未启用：请设置 EMBED_API_KEY 与 EMBED_MODEL');
  const list = Array.isArray(texts) ? texts : [texts];
  // 向量形状必须自己验：实测同一个模型名下接口可能对两条文本返回不同维度的向量（16 维 / 4 维），
  // cosine() 按较短的数组点数相乘不会报错，只得到一个 0.97 的假相似度 —— 语义边看起来「跑成功了」，
  // 内容却全是错的，用户没有任何线索。这里一律先验再入库。
  const checked = rows => { checkVecs(rows); return rows; };
  // Google Gemini：POST {base}/{model}:batchEmbedContents，一次最多 100 条。
  // 与 OpenAI 格式的三处差异：key 走 x-goog-api-key 头、每条要自带 model 全名与 content.parts、
  // 检索要声明 taskType。base 默认 v1beta（generativelanguage.googleapis.com/v1beta）。
  if (embedProtocol() === 'gemini') {
    const base = (EMBED_BASE_ENV || GEMINI_BASE_DEFAULT).replace(/\/+$/, '');
    const modelPath = /^models\//.test(EMBED_MODEL) ? EMBED_MODEL : `models/${EMBED_MODEL}`;
    const taskType = type === 'query' ? 'RETRIEVAL_QUERY' : 'RETRIEVAL_DOCUMENT';
    const out = [];
    for (let i = 0; i < list.length; i += 16) {
      assertNotAborted();
      await gate();
      try {
        const chunk = list.slice(i, i + 16);
        const payload = {requests: chunk.map(t => ({
          model: modelPath,
          content: {parts: [{text: String(t ?? '').trim() || '（无内容）'}]}, // Gemini 拒收空 text，空值要兜底
          taskType,
          ...(EMBED_DIM ? {outputDimensionality: EMBED_DIM} : {})
        }))};
        let res2, raw;
        try {
          res2 = await fetch(`${base}/${modelPath}:batchEmbedContents`, {
            method: 'POST',
            headers: {'content-type': 'application/json', 'x-goog-api-key': EMBED_KEY_ENV},
            body: JSON.stringify(payload),
            signal: withJob(AbortSignal.timeout(TIMEOUT))
          });
          raw = await res2.text();
        } catch (e) {
          if (e.name === 'AbortError') {
            if (jobAborted()) throw abortError();
            throw new Error('Gemini embedding 请求超时（' + TIMEOUT / 1000 + 's）');
          }
          throw new Error('Gemini embedding 请求失败：' + netReason(e));
        }
        if (!res2.ok) {
          // 同 call()：原文只进日志，对外只回翻译过的原因（这段会进 relate 的 job.error 再回浏览器）。
          console.error(`[ai] Gemini embedding 返回 ${res2.status}：${String(raw).slice(0, 400)}`);
          throw new Error(geminiEmbedError(res2.status, raw));
        }
        let parsed;
        try { parsed = JSON.parse(raw); } catch { throw new Error('Gemini embedding 返回的不是 JSON：' + String(raw).slice(0, 200)); }
        // 形状：{embeddings: [{values: [...]}, …]}；值可能是 base64（新版接口）或数组，这里只认数组。
        const rows = (parsed.embeddings || []).map(e => e.values);
        if (rows.length !== chunk.length) throw new Error(`embedding 返回条数不对（要 ${chunk.length} 条，拿到 ${rows.length} 条）`);
        out.push(...rows);
      } finally { release(); }
    }
    return checked(out);
  }

  // Cloudflare Workers AI：免费额度每天 10,000 Neurons，bge-m3 很够用。
  // 接口不是 OpenAI 格式：POST /ai/run/{model}，body {text: [...]}，返回 {result: {data: [[...]]}}。
  if (embedProtocol() === 'cloudflare') {
    const acct = process.env.CF_ACCOUNT_ID || '';
    if (!acct) throw new Error('EMBED_PROTOCOL=cloudflare 需要 CF_ACCOUNT_ID');
    const out = [];
    for (let i = 0; i < list.length; i += 16) {
      await gate();
      try {
        const EMBED_BASE = EMBED_BASE_ENV || CHAT_BASE, EMBED_KEY = EMBED_KEY_ENV || CHAT_KEY;
        const res = await fetch(`${EMBED_BASE}/accounts/${acct}/ai/run/${EMBED_MODEL}`, {
          method: 'POST',
          headers: {'content-type': 'application/json', authorization: `Bearer ${EMBED_KEY}`},
          body: JSON.stringify({text: list.slice(i, i + 16)}),
          signal: withJob(AbortSignal.timeout(TIMEOUT))
        });
        if (!res.ok) {
          // 同 call()：原文只进日志，对外只回分类原因（这段会进 relate 的 job.error 再回浏览器）。
          console.error(`[ai] Cloudflare AI 返回 ${res.status}：${(await res.text().catch(() => '')).slice(0, 400)}`);
          throw new Error(upstreamError(res.status));
        }
        const j = await res.json();
        const rows = j.result?.data || [];
        if (rows.length !== Math.min(16, list.length - i)) throw new Error('embedding 返回条数不对');
        out.push(...rows);
      } finally { release(); }
    }
    return checked(out);
  }
  const out = [];
  const EMBED_BASE = EMBED_BASE_ENV || CHAT_BASE, EMBED_KEY = EMBED_KEY_ENV || CHAT_KEY;
  // 单请求条数上限各家不同（硅基流动 64、阿里 DashScope 10、部分网关 16），写死一个数必然在
  // 某家上 400。所以按 16 起步，遇到「批量太大」类 400 就二分重试——比让用户去查文档改环境变量友好。
  const tooMany = e => e.upstreamStatus === 400
    && /batch\s*size|too many|up to|larger than|最多|一次|条数|数量/i.test(e.upstreamBody || e.message);
  const embedChunk = async (items) => {
    try {
      return await call(EMBED_BASE, EMBED_KEY, '/embeddings', {
        model: EMBED_MODEL, input: items,
        ...(EMBED_DIM ? {dimensions: EMBED_DIM} : {})
      });
    } catch (e) {
      if (items.length > 1 && tooMany(e)) {
        const mid = Math.ceil(items.length / 2);
        const a = await embedChunk(items.slice(0, mid));
        const b = await embedChunk(items.slice(mid));
        return {data: [...(a.data || []), ...(b.data || [])]};
      }
      throw e;
    }
  };
  for (let i = 0; i < list.length; i += 16) {
    assertNotAborted();
    const chunk = list.slice(i, i + 16);
    let data;
    try {
      data = await embedChunk(chunk);
    } catch (e) {
      // 404 十有八九不是「模型名写错」，而是这个网关根本没有 /embeddings（DeepSeek 系普遍没有）。
      // 泛泛的「检查 Base URL 是否以 /v1 结尾」会让人去改一个本来就对的地址。
      if (/（404）/.test(e.message)) {
        throw new Error('embedding 接口不存在（404）：当前 EMBED_BASE_URL 没有 /embeddings。'
          + 'DeepSeek 系模型不提供 embedding，请把 EMBED_BASE_URL / EMBED_MODEL 指向支持 embedding 的服务'
          + '（如硅基流动 BAAI/bge-m3、阿里 DashScope text-embedding-v3、Google gemini-embedding-001），'
          + '或设置 EMBED_PROTOCOL=cloudflare + CF_ACCOUNT_ID，或 EMBED_PROTOCOL=gemini + EMBED_API_KEY');
      }
      throw e;
    }
    const rows = data.data?.map(d => d.embedding) || [];
    if (rows.length !== chunk.length) throw new Error(`embedding 返回条数不对（要 ${chunk.length} 条，拿到 ${rows.length} 条）`);
    out.push(...rows);
  }
  return checked(out);
}

// —— 四个能力的提示词 ——
const SYS = '你是创作者笔记库的助手。只输出被要求的内容，不要解释。';

// ① 打标签 + 摘要。tags 限 3-6 个、用笔记里出现过的词；summary 一句话，中文。
export async function analyzeNote(title, body, {model} = {}) {
  const text = String(body || '').slice(0, 3500); // 控制输入 token
  const out = await chat([
    {role: 'system', content: SYS + ' 输出 JSON：{"tags":["…"],"summary":"一句话摘要"}'},
    {role: 'user', content: `标题：${title}\n\n正文：\n${text}\n\n给这篇笔记 3-6 个话题标签（优先用正文里的词）和一句 30 字以内的中文摘要。`}
  ], {json: true, model});
  const tags = [...new Set(asArray(pickKey(out, 'tags', '标签', '话题标签')).map(t => String(t).replace(/^#/, '').trim()).filter(Boolean))].slice(0, 6);
  return {tags, summary: oneLine(asText(pickKey(out, 'summary', '摘要', '一句话摘要'))).slice(0, 120)};
}

// ③ 选题候选
export async function generateIdeas(notes, {model} = {}) {
  const digest = notes.map(n => `【${n.title}】${String(n.body || '').slice(0, 400)}`).join('\n\n');
  const out = await chat([
    {role: 'system', content: SYS + ' 输出 JSON：{"ideas":[{"title":"…","platform":"小红书","priority":"中","note":"选题理由与切入角度","sourceTitles":["…"]}]}'},
    {role: 'user', content: `从这些笔记里挖 3 个值得写的选题（贴近笔记内容、能落地）：\n\n${digest.slice(0, 6000)}`}
  ], {json: true, model});
  // 形状归一：ideas 给了对象 / null、单条不是对象（模型常见漂移）时不能让 .map 抛 TypeError
  return pickList(out, ['ideas', '选题', 'candidates', 'topics']).filter(i => i && typeof i === 'object').slice(0, 5).map(i => ({
    title: String(pickKey(i, 'title', '标题') || '').slice(0, 80),
    platform: ['小红书', 'B站', '公众号', '抖音'].includes(pickKey(i, 'platform', '平台')) ? pickKey(i, 'platform', '平台') : '小红书',
    priority: ['高', '中', '低'].includes(pickKey(i, 'priority', '优先级')) ? pickKey(i, 'priority', '优先级') : '中',
    note: String(pickKey(i, 'note', '理由', '选题理由', '切入点', 'description', 'angle', '大纲') || longestStr(i, ['title', '标题'])).slice(0, 300),
    sourceTitles: asArray(pickKey(i, 'sourceTitles', '来源', '来源笔记')).length
      ? asArray(pickKey(i, 'sourceTitles', '来源', '来源笔记')).map(String).slice(0, 3)
      : firstStrList(i).slice(0, 3)
  })).filter(i => i.title);
}

// ⑤ 网页剪藏分析：摘要 + 要点 + 标签（个人知识库「推文 / 文章」用）。
export async function analyzeWebPage({url, title, text}, {model} = {}) {
  // 网页分析是「读长文 + 提炼」，和打标签的性价比取向不同，默认走 AI_MODEL_WEB
  // （原来不带 model 时一律用全局默认模型，配了 AI_MODEL_WEB 也不生效）。
  model = model || taskModel('web');
  const body = String(text || '').slice(0, 8000); // 控制输入 token
  const out = await chat([
    {role: 'system', content: SYS + ' 输出 JSON：{"summary":"一句话摘要","keyPoints":["…"],"tags":["…"],"title":"30字以内标题"}'},
    {role: 'user', content: `URL：${url || '（无）'}\n标题：${title || '（无）'}\n\n正文：\n${body}\n\n分析这个网页：给一句 40 字以内的中文摘要、3-6 条要点（保留原文关键信息与数据）、3-6 个话题标签（优先用正文里的词）${title ? '' : '，再从正文提炼一个 30 字以内、能当文件名的标题（title 字段）'}。`}
  ], {json: true, model});
  const tags = [...new Set(asArray(pickKey(out, 'tags', '标签')).map(t => String(t).replace(/^#/, '').trim()).filter(Boolean))].slice(0, 6);
  const keyPoints = asArray(pickKey(out, 'keyPoints', '要点', '关键点')).map(oneLine).filter(Boolean).slice(0, 6);
  return {summary: oneLine(asText(pickKey(out, 'summary', '摘要'))).slice(0, 160), keyPoints, tags,
    title: oneLine(asText(pickKey(out, 'title', '标题'))).slice(0, 60) || null};
}

// ④ 问答（上下文由调用方拼好，这里不检索）。
// 返回 {text, used}：used 是真正进了上下文的篇目。原来返回纯文本，调用方按「全部命中」
// 生成 refs，被预算切掉的笔记也会列成引用 —— 点开只能说「笔记里没有」。
export async function answer(question, contexts, {model} = {}) {
  const BUDGET = 8800, HEAD = 800, TAIL = 300;
  // 命中点常在长笔记的后半段：只截前 1200 字等于喂了一段无关内容，模型会照着
  // system 提示如实回答「没有」，用户以为库里没这篇。改成「开头 + 结尾」两段带中略。
  const bodyOf = c => {
    const t = String(c.body || '').replace(/\s+/g, ' ').trim();
    if (t.length <= HEAD + TAIL) return t;
    return `${t.slice(0, HEAD)}\n……（中略）……\n${t.slice(-TAIL)}`;
  };
  const parts = [], used = [];
  let total = 0;
  for (const c of contexts) {
    const part = `[${parts.length + 1}] ${c.title}\n${bodyOf(c)}`;
    if (total + part.length + 2 > BUDGET) break;
    parts.push(part); used.push(c); total += part.length + 2;
  }
  if (!parts.length) return {text: '笔记库里没有找到相关内容。', used: []};
  const text = await chat([
    {role: 'system', content: '根据提供的笔记回答问题。引用了哪篇笔记就在句末标注 [编号]。笔记里没有的就说没有，不要编。中文回答。'},
    {role: 'user', content: `笔记：\n\n${parts.join('\n\n')}\n\n问题：${question}`}
  ], {temperature: 0.2, maxTokens: 1200, model});
  return {text, used};
}
