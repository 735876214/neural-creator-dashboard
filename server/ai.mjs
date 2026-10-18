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
//   EMBED_PROTOCOL  openai（默认）或 cloudflare（Workers AI 原生格式，需 CF_ACCOUNT_ID）
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
let CHAT_BASE = (process.env.AI_BASE_URL || 'https://api.deepseek.com/v1').replace(/\/+$/, '');
let CHAT_KEY = process.env.AI_API_KEY || '';
let CHAT_MODEL = process.env.AI_MODEL || 'deepseek-chat';

// 设置面板保存后即时生效：覆盖 baseUrl / key / 全局默认模型；传 '' 恢复 env 缺省，null 忽略。
let modelCacheRef = null; // 由下方 modelCache 声明回填
export function setAiRuntime({baseUrl, apiKey, model} = {}) {
  if (baseUrl != null) CHAT_BASE = String(baseUrl).trim() ? String(baseUrl).trim().replace(/\/+$/, '') : (process.env.AI_BASE_URL || 'https://api.deepseek.com/v1').replace(/\/+$/, '');
  if (apiKey != null) CHAT_KEY = String(apiKey);
  if (model != null) CHAT_MODEL = String(model).trim() || (process.env.AI_MODEL || 'deepseek-chat');
  if (modelCacheRef) modelCacheRef.at = 0; // base/key/model 变更后强制重拉模型列表
}
// 各任务的默认模型：缺省回落 AI_MODEL
const TASK_ENV = {ask: 'AI_MODEL_ASK', analyze: 'AI_MODEL_ANALYZE', ideas: 'AI_MODEL_IDEAS', news: 'AI_MODEL_NEWS', web: 'AI_MODEL_WEB'};
// 任务级模型：env 显式设置优先；未设则跟随运行时全局模型（设置面板可改）
export const taskModel = task => process.env[TASK_ENV[task]] || CHAT_MODEL;
// 兼容旧引用（/api/ai/models 的 taskModels 字段）
export const TASK_MODELS = new Proxy({}, {get: (_, task) => taskModel(task), has: (_, task) => task in TASK_ENV, ownKeys: () => Object.keys(TASK_ENV)});
const EMBED_BASE_ENV = process.env.EMBED_BASE_URL || '';
const EMBED_KEY_ENV = process.env.EMBED_API_KEY || '';
const EMBED_MODEL = process.env.EMBED_MODEL || '';
const TIMEOUT = Number(process.env.AI_TIMEOUT || 60_000);

export const aiEnabled = () => PROTOCOL === 'anthropic' ? !!CHAT_BASE : !!CHAT_KEY;
export const embedEnabled = () => !!(EMBED_KEY_ENV || CHAT_KEY) && !!EMBED_MODEL;
export const aiInfo = () => ({
  enabled: aiEnabled(), model: CHAT_MODEL, protocol: PROTOCOL,
  taskModels: TASK_MODELS,
  embed: embedEnabled() ? {model: EMBED_MODEL, sameBase: (EMBED_BASE_ENV || CHAT_BASE) === CHAT_BASE} : {enabled: false}
});

// —— 模型列表（前端下拉用）：/v1/models，缓存 10 分钟 ——
const modelCache = {at: 0, list: []};
modelCacheRef = modelCache;
export async function listModels() {
  if (Date.now() - modelCache.at < 10 * 60_000) return modelCache.list;
  try {
    const res = await fetch(CHAT_BASE + '/models', {headers: {authorization: `Bearer ${CHAT_KEY}`}, signal: AbortSignal.timeout(8000)});
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const j = await res.json();
    modelCache.at = Date.now();
    modelCache.list = (j.data || []).map(m => ({
      id: m.id, name: m.name || m.id,
      reasoning: !!(m.only_reasoning || m.reasoning_supported || /reasoning/i.test(String(m.tags || '')))
    }));
  } catch (e) {
    if (!modelCache.list.length) console.error('[ai] 拉取模型列表失败：', e.message);
    // 失败时保留旧缓存；从来没有成功过就只报默认模型
    if (!modelCache.list.length) {
      modelCache.at = Date.now();
      modelCache.list = [{id: CHAT_MODEL, name: CHAT_MODEL, reasoning: false}];
    }
  }
  return modelCache.list;
}
export async function validModel(id) {
  if (!id) return false;
  return (await listModels()).some(m => m.id === id);
}

// 并发闸：AI 供应商普遍有 RPM 限制，个人自用限到 4 足够，也保护 NAS 的内存。
let active = 0;
const waiters = [];
const MAX_CONCURRENT = Number(process.env.AI_CONCURRENCY || 4);
async function gate() {
  if (active < MAX_CONCURRENT) { active++; return; }
  await new Promise(r => waiters.push(r));
  active++;
}
const release = () => { active--; waiters.shift()?.(); };

async function call(base, key, path, payload) {
  await gate();
  try {
    for (let attempt = 0; ; attempt++) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), TIMEOUT);
      try {
        const res = await fetch(base + path, {
          method: 'POST',
          headers: {'content-type': 'application/json', authorization: `Bearer ${key}`},
          body: JSON.stringify(payload), signal: ctrl.signal
        });
        if ((res.status === 429 || res.status >= 500) && attempt < 2) {
          await new Promise(r => setTimeout(r, 1000 * 2 ** attempt));
          continue;
        }
        if (!res.ok) {
          const text = await res.text().catch(() => '');
          throw new Error(`AI 接口 ${res.status}：${text.slice(0, 200)}`);
        }
        return await res.json();
      } catch (e) {
        if (e.name === 'AbortError') throw new Error('AI 请求超时（' + TIMEOUT / 1000 + 's）');
        if (attempt >= 2) throw e;
        await new Promise(r => setTimeout(r, 1000 * 2 ** attempt));
      } finally { clearTimeout(timer); }
    }
  } finally { release(); }
}

// 从 OpenAI 格式回复里取文本：content 为空时兜底 reasoning_content（思考型模型），
// 再兜底 message 是字符串 / 数组的情况。返回 null 表示真的没有内容。
function textOf(msg) {
  if (!msg) return null;
  let c = msg.content;
  if (Array.isArray(c)) c = c.filter(b => b.type === 'text').map(b => b.text).join('');
  if (typeof c === 'string' && c.trim()) return c;
  const r = msg.reasoning_content || msg.reasoning;
  if (typeof r === 'string' && r.trim()) return r;
  return null;
}

function parseJson(text) {
  try { return JSON.parse(text); }
  catch {
    const m = text.match(/[[{][\s\S]*[\]}]/);
    if (m) { try { return JSON.parse(m[0]); } catch {} }
    throw new Error('AI 没有返回合法 JSON：' + text.slice(0, 120));
  }
}

// 要严格 JSON 时走 response_format，供应商不支持时靠正则从回复里抠。
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
    const data = await call(CHAT_BASE, CHAT_KEY, '/v1/messages', payload);
    const text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
    if (!text) throw new Error('AI 返回了空回复（可能全是 thinking 块），换个措辞再试');
    return json ? parseJson(text) : text;
  }
  const payload = {model: useModel, messages, temperature, max_tokens: maxTokens};
  if (json) payload.response_format = {type: 'json_object'};
  const data = await call(CHAT_BASE, CHAT_KEY, '/chat/completions', payload);
  const text = textOf(data.choices?.[0]?.message);
  if (!text) throw new Error('AI 返回了空回复（模型 ' + useModel + ' 可能是纯思考型且被截断），换个模型或加大 max_tokens');
  return json ? parseJson(text) : text;
}

export async function embed(texts) {
  if (!embedEnabled()) throw new Error('embedding 未启用：请设置 EMBED_API_KEY 与 EMBED_MODEL');
  const list = Array.isArray(texts) ? texts : [texts];
  // Cloudflare Workers AI：免费额度每天 10,000 Neurons，bge-m3 很够用。
  // 接口不是 OpenAI 格式：POST /ai/run/{model}，body {text: [...]}，返回 {result: {data: [[...]]}}。
  if ((process.env.EMBED_PROTOCOL || '').toLowerCase() === 'cloudflare') {
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
          signal: AbortSignal.timeout(TIMEOUT)
        });
        if (!res.ok) throw new Error(`Cloudflare AI ${res.status}：${(await res.text().catch(() => '')).slice(0, 150)}`);
        const j = await res.json();
        const rows = j.result?.data || [];
        if (rows.length !== Math.min(16, list.length - i)) throw new Error('embedding 返回条数不对');
        out.push(...rows);
      } finally { release(); }
    }
    return out;
  }
  const out = [];
  // 分批：多数接口单请求上限 16-64 条
  for (let i = 0; i < list.length; i += 16) {
    const EMBED_BASE = EMBED_BASE_ENV || CHAT_BASE, EMBED_KEY = EMBED_KEY_ENV || CHAT_KEY;
    const data = await call(EMBED_BASE, EMBED_KEY, '/embeddings', {model: EMBED_MODEL, input: list.slice(i, i + 16)});
    const rows = data.data?.map(d => d.embedding) || [];
    if (rows.length !== Math.min(16, list.length - i)) throw new Error('embedding 返回条数不对');
    out.push(...rows);
  }
  return out;
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
  const tags = [...new Set((out.tags || []).map(t => String(t).replace(/^#/, '').trim()).filter(Boolean))].slice(0, 6);
  return {tags, summary: String(out.summary || '').slice(0, 120)};
}

// ③ 选题候选
export async function generateIdeas(notes, {model} = {}) {
  const digest = notes.map(n => `【${n.title}】${String(n.body || '').slice(0, 400)}`).join('\n\n');
  const out = await chat([
    {role: 'system', content: SYS + ' 输出 JSON：{"ideas":[{"title":"…","platform":"小红书","priority":"中","note":"选题理由与切入角度","sourceTitles":["…"]}]}'},
    {role: 'user', content: `从这些笔记里挖 3 个值得写的选题（贴近笔记内容、能落地）：\n\n${digest.slice(0, 6000)}`}
  ], {json: true, model});
  return (out.ideas || []).slice(0, 5).map(i => ({
    title: String(i.title || '').slice(0, 80),
    platform: ['小红书', 'B站', '公众号', '抖音'].includes(i.platform) ? i.platform : '小红书',
    priority: ['高', '中', '低'].includes(i.priority) ? i.priority : '中',
    note: String(i.note || '').slice(0, 300),
    sourceTitles: (i.sourceTitles || []).map(String).slice(0, 3)
  })).filter(i => i.title);
}

// ⑤ 网页剪藏分析：摘要 + 要点 + 标签（个人知识库「推文 / 文章」用）。
export async function analyzeWebPage({url, title, text}, {model} = {}) {
  const body = String(text || '').slice(0, 8000); // 控制输入 token
  const out = await chat([
    {role: 'system', content: SYS + ' 输出 JSON：{"summary":"一句话摘要","keyPoints":["…"],"tags":["…"],"title":"30字以内标题"}'},
    {role: 'user', content: `URL：${url || '（无）'}\n标题：${title || '（无）'}\n\n正文：\n${body}\n\n分析这个网页：给一句 40 字以内的中文摘要、3-6 条要点（保留原文关键信息与数据）、3-6 个话题标签（优先用正文里的词）${title ? '' : '，再从正文提炼一个 30 字以内、能当文件名的标题（title 字段）'}。`}
  ], {json: true, model});
  const tags = [...new Set((out.tags || []).map(t => String(t).replace(/^#/, '').trim()).filter(Boolean))].slice(0, 6);
  const keyPoints = (out.keyPoints || []).map(p => String(p).trim()).filter(Boolean).slice(0, 6);
  return {summary: String(out.summary || '').slice(0, 160), keyPoints, tags, title: String(out.title || '').trim().slice(0, 60) || null};
}

// ④ 问答（返回文本；上下文由调用方拼好，这里不检索）
export async function answer(question, contexts, {model} = {}) {
  const ctx = contexts.map((c, i) => `[${i + 1}] ${c.title}\n${String(c.body || '').slice(0, 1200)}`).join('\n\n');
  return chat([
    {role: 'system', content: '根据提供的笔记回答问题。引用了哪篇笔记就在句末标注 [编号]。笔记里没有的就说没有，不要编。中文回答。'},
    {role: 'user', content: `笔记：\n\n${ctx.slice(0, 8000)}\n\n问题：${question}`}
  ], {temperature: 0.2, maxTokens: 1200, model});
}
