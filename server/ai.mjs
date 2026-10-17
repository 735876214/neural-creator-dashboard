// AI 调用层：统一走 OpenAI 兼容的 /chat/completions 与 /embeddings。
//
// 换厂商只改环境变量，不改代码：
//   AI_BASE_URL   默认 https://api.deepseek.com/v1（DeepSeek、通义 DashScope 兼容模式、
//                 Kimi、硅基流动都兼容这个格式；Claude 需要兼容网关）
//   AI_API_KEY    chat 模型的 key（必填才启用 AI）
//   AI_MODEL      chat 模型名，默认 deepseek-chat
//   EMBED_BASE_URL  不设就沿用 AI_BASE_URL（注意 DeepSeek 没有 embedding 接口，
//                   只配 DeepSeek 时语义关联不可用，其余功能正常）
//   EMBED_API_KEY / EMBED_MODEL   embedding 用（bge-m3、text-embedding-v3 等）
//
// 护栏：超时、限次重试、并发闸、JSON 输出解析兜底。key 只在服务端，绝不进前端。
//
// 协议由 AI_PROTOCOL 选择：
//   openai    （默认）OpenAI 兼容 /chat/completions —— DeepSeek、通义、Kimi、硅基流动
//   anthropic Anthropic /v1/messages —— Claude 官方、智谱 / Kimi / MiniMax 的 Anthropic 端点，
//             以及 CC Switch 这类本地代理（复用 VS Code / Claude Code 已有的账号与额度，
//             代理本身校验来源时才需要 AI_API_KEY）。
const PROTOCOL = (process.env.AI_PROTOCOL || 'openai').toLowerCase();
const CHAT_BASE = (process.env.AI_BASE_URL || 'https://api.deepseek.com/v1').replace(/\/+$/, '');
const CHAT_KEY = process.env.AI_API_KEY || '';
const CHAT_MODEL = process.env.AI_MODEL || 'deepseek-chat';
const EMBED_BASE = (process.env.EMBED_BASE_URL || CHAT_BASE).replace(/\/+$/, '');
const EMBED_KEY = process.env.EMBED_API_KEY || CHAT_KEY;
const EMBED_MODEL = process.env.EMBED_MODEL || '';
const TIMEOUT = Number(process.env.AI_TIMEOUT || 60_000);

export const aiEnabled = () => PROTOCOL === 'anthropic' ? !!CHAT_BASE : !!CHAT_KEY;
export const embedEnabled = () => !!EMBED_KEY && !!EMBED_MODEL;
export const aiInfo = () => ({
  enabled: aiEnabled(), model: CHAT_MODEL, protocol: PROTOCOL,
  embed: embedEnabled() ? {model: EMBED_MODEL, sameBase: EMBED_BASE === CHAT_BASE} : {enabled: false}
});

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

// 要严格 JSON 时走 response_format，供应商不支持时靠正则从回复里抠。
export async function chat(messages, {json = false, temperature = 0.3, maxTokens = 1500} = {}) {
  if (!aiEnabled()) throw new Error('AI 未启用：请设置 AI_API_KEY（或 Anthropic 模式下的 AI_BASE_URL）');
  if (PROTOCOL === 'anthropic') {
    // Anthropic /v1/messages：system 单独传，消息只收 user/assistant；
    // 回复可能是 [text, thinking, ...] 块数组，拼接所有 text 块。
    const sys = messages.filter(m => m.role === 'system').map(m => m.content).join('\n');
    const rest = messages.filter(m => m.role !== 'system');
    const payload = {model: CHAT_MODEL, max_tokens: maxTokens, temperature, messages: rest};
    if (sys) payload.system = sys;
    const data = await call(CHAT_BASE, CHAT_KEY, '/v1/messages', payload);
    const text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
    if (!text) throw new Error('AI 返回了空回复（可能全是 thinking 块），换个措辞再试');
    if (!json) return text;
    try { return JSON.parse(text); }
    catch {
      const m = text.match(/[[{][\s\S]*[\]}]/);
      if (m) { try { return JSON.parse(m[0]); } catch {} }
      throw new Error('AI 没有返回合法 JSON：' + text.slice(0, 120));
    }
  }
  const payload = {model: CHAT_MODEL, messages, temperature, max_tokens: maxTokens};
  if (json) payload.response_format = {type: 'json_object'};
  const data = await call(CHAT_BASE, CHAT_KEY, '/chat/completions', payload);
  const text = data.choices?.[0]?.message?.content ?? '';
  if (!json) return text;
  try { return JSON.parse(text); }
  catch {
    const m = text.match(/[[{][\s\S]*[\]}]/);
    if (m) { try { return JSON.parse(m[0]); } catch {} }
    throw new Error('AI 没有返回合法 JSON：' + text.slice(0, 120));
  }
}

export async function embed(texts) {
  if (!embedEnabled()) throw new Error('embedding 未启用：请设置 EMBED_API_KEY 与 EMBED_MODEL');
  const list = Array.isArray(texts) ? texts : [texts];
  const out = [];
  // 分批：多数接口单请求上限 16-64 条
  for (let i = 0; i < list.length; i += 16) {
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
export async function analyzeNote(title, body) {
  const text = String(body || '').slice(0, 3500); // 控制输入 token
  const out = await chat([
    {role: 'system', content: SYS + ' 输出 JSON：{"tags":["…"],"summary":"一句话摘要"}'},
    {role: 'user', content: `标题：${title}\n\n正文：\n${text}\n\n给这篇笔记 3-6 个话题标签（优先用正文里的词）和一句 30 字以内的中文摘要。`}
  ], {json: true});
  const tags = [...new Set((out.tags || []).map(t => String(t).replace(/^#/, '').trim()).filter(Boolean))].slice(0, 6);
  return {tags, summary: String(out.summary || '').slice(0, 120)};
}

// ③ 选题候选
export async function generateIdeas(notes) {
  const digest = notes.map(n => `【${n.title}】${String(n.body || '').slice(0, 400)}`).join('\n\n');
  const out = await chat([
    {role: 'system', content: SYS + ' 输出 JSON：{"ideas":[{"title":"…","platform":"小红书","priority":"中","note":"选题理由与切入角度","sourceTitles":["…"]}]}'},
    {role: 'user', content: `从这些笔记里挖 3 个值得写的选题（贴近笔记内容、能落地）：\n\n${digest.slice(0, 6000)}`}
  ], {json: true});
  return (out.ideas || []).slice(0, 5).map(i => ({
    title: String(i.title || '').slice(0, 80),
    platform: ['小红书', 'B站', '公众号', '抖音'].includes(i.platform) ? i.platform : '小红书',
    priority: ['高', '中', '低'].includes(i.priority) ? i.priority : '中',
    note: String(i.note || '').slice(0, 300),
    sourceTitles: (i.sourceTitles || []).map(String).slice(0, 3)
  })).filter(i => i.title);
}

// ④ 问答（返回文本；上下文由调用方拼好，这里不检索）
export async function answer(question, contexts) {
  const ctx = contexts.map((c, i) => `[${i + 1}] ${c.title}\n${String(c.body || '').slice(0, 1200)}`).join('\n\n');
  return chat([
    {role: 'system', content: '根据提供的笔记回答问题。引用了哪篇笔记就在句末标注 [编号]。笔记里没有的就说没有，不要编。中文回答。'},
    {role: 'user', content: `笔记：\n\n${ctx.slice(0, 8000)}\n\n问题：${question}`}
  ], {temperature: 0.2, maxTokens: 1200});
}
