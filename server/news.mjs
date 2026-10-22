// AI 热点日报（第六星座「AI 热点」的数据）。
//
// 不重复造轮子：热点条目直接消费现成的公开 RSS 源（默认 aihot.news 的「全部 AI 动态」，
// NewsNow 生态；可用 NEWS_SOURCE 换成任何 RSS 2.0 源），本项目只做三件事：
//   1. 拉取 + 解析 + 按 guid 去重；
//   2. 用网关模型把当天的 20-40 条压成一段日报 + 主题分组；
//   3. 写进 vault（00-AI热点/YYYY-MM-DD.md，自动进图谱）和 SQLite（news 表）。
//
// 定时：startNewsCron 每小时检查一次，当天还没有日报且已过 NEWS_HOUR（默认 8 点）就生成。
// 环境变量：NEWS_SOURCE（RSS 地址）、NEWS_HOUR（生成时刻）、NEWS_TZ_OFFSET（默认 8）、NEWS_CRON=0 关闭。
import {writeFileSync, mkdirSync, existsSync, readFileSync, renameSync, rmSync, copyFileSync, openSync, fsyncSync, closeSync} from 'node:fs';
import {dirname, basename, join} from 'node:path';
import {writeDoc} from './frontmatter.mjs';
import {chat, TASK_MODELS, aiEnabled, pickKey, pickList, longestStr, firstStrList, topicEntries} from './ai.mjs';
const NEWS_SOURCE = process.env.NEWS_SOURCE || 'https://aihot.news/feed/all.xml';
// NEWS_HOUR='08:00' / 'abc' 时 Number() 得到 NaN，`hours < NaN` 恒假 ⇒ 启动即生成日报（与「等到 8 点」相反）。
const parsedHour = Number(process.env.NEWS_HOUR);
const NEWS_HOUR = Number.isFinite(parsedHour) && parsedHour >= 0 && parsedHour <= 23 ? parsedHour : 8;
if (process.env.NEWS_HOUR && NEWS_HOUR !== parsedHour) console.error(`[news] NEWS_HOUR=${process.env.NEWS_HOUR} 不是 0–23 的数字，改用 ${NEWS_HOUR}`);
const NEWS_DIR = '00-AI热点';
const MAX_ITEMS = 40;

// 带 HTTP 状态的自定义错误：路由据此回 501 / 502 / 409，而不是把所有原因都塌成 500「服务器内部错误」
// （同一产品里 /api/ai/* 在未配 key 时回 501，日报却回 500，用户分不清是配置问题还是服务出错）。
const newsError = (status, message) => Object.assign(new Error(message), {status});

// 容器默认 UTC（镜像不装 tzdata）：用显式偏移判定「几点之后」和「今天是哪天」，
// 否则 NEWS_HOUR=8 在北京时间是 16:00，凌晨重启还会把日报写到前一天。
const TZ_OFFSET_RAW = Number(process.env.NEWS_TZ_OFFSET);
const TZ_OFFSET = Number.isFinite(TZ_OFFSET_RAW) ? TZ_OFFSET_RAW : 8;
const localNow = (ms = Date.now()) => new Date(ms + TZ_OFFSET * 3600_000);
// 传进来的 Date 已偏移到固定时区，统一用 UTC 字段取值。
const localDate = (d = localNow()) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;

// 日报 .md 的有效性：文件存在且是一份完整文档（有 frontmatter 栅栏、非空）。
// 只看 existsSync 会把写坏的半截文件当成「已生成」，之后永远不会被修复。
function validMd(path) {
  try {
    const t = readFileSync(path, 'utf8');
    return t.trim().length > 0 && t.startsWith('---') && t.indexOf('\n---', 3) > 0;
  } catch { return false; }
}

// 同目录临时文件 + rename：写盘中途被杀/断电只会留下完整旧版或完整新版。
// 临时文件名必须写成「点 + 原名 + pid-时间戳.tmp」：不加前导点的话（原来就是 `path + '.123-169.tmp'`），
// server/index.mjs 的 TEMP_FILE_RE（/^\..+\.\d+-\d+\.tmp$/）匹配不到，崩溃残留永远不会被清理，
// 而是被 Obsidian / Syncthing / git 当成普通笔记带走。
function writeMdAtomic(path, text) {
  const tmp = join(dirname(path), `.${basename(path)}.${process.pid}-${Date.now()}.tmp`);
  try {
    writeFileSync(tmp, text, 'utf8');
    // rename 只保证「不出现半截文件」，不保证数据块先于目录项落盘：掉电后可能变成 0 字节
    const fd = openSync(tmp, 'r');
    try { fsyncSync(fd); } finally { try { closeSync(fd); } catch {} }
    renameSync(tmp, path);
  } catch (e) {
    try { rmSync(tmp, {force: true}); } catch {}
    throw e;
  }
}

// 「今天已经试过几次」：缓存行没了但 .md 也写不进去时（磁盘满 / 目录只读），cron 每 30 分钟
// 会重新拉一次 RSS 并跑一次完整 AI 汇总。同一天失败 3 次就停下，别再烧模型。
const attempts = new Map();
const bumpAttempt = date => {
  const n = (attempts.get(date) || 0) + 1;
  attempts.set(date, n);
  return n;
};

// —— RSS 2.0 极简解析（只用正则；源是标准 RSS，不值得为此引依赖） ——
const cdata = s => String(s || '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
const stripTags = s => cdata(s).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

export async function fetchAiNews(source = NEWS_SOURCE) {
  let res;
  try {
    res = await fetch(source, {signal: AbortSignal.timeout(20_000), headers: {'user-agent': 'neural-dashboard/0.6'}});
  } catch (e) {
    throw newsError(502, `RSS 拉取失败：${e?.name === 'TimeoutError' ? '请求超时（20s）' : (e.message || '网络错误')}`);
  }
  if (!res.ok) throw newsError(502, `RSS 拉取失败：HTTP ${res.status}`);
  const xml = await res.text();
  const items = [];
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const block = m[1];
    const get = tag => (block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`)) || [])[1];
    const title = stripTags(get('title'));
    if (!title) continue;
    items.push({
      title: title.slice(0, 160),
      link: cdata(get('link') || '').trim(),
      date: get('pubDate') ? new Date(cdata(get('pubDate')).trim()) : null,
      summary: stripTags(get('description')).slice(0, 300),
      guid: cdata(get('guid') || '').trim() || title
    });
  }
  // 按 guid 去重、只要最近 48h、按时间倒序、限量
  const cutoff = Date.now() - 48 * 3600_000;
  const seen = new Set();
  return items
    .filter(it => it.guid && !seen.has(it.guid) && seen.add(it.guid))
    .filter(it => !it.date || isNaN(it.date) || it.date.getTime() >= cutoff)
    .sort((a, b) => (b.date?.getTime() || 0) - (a.date?.getTime() || 0))
    .slice(0, MAX_ITEMS);
}

// —— AI 汇总：一段日报 + 主题分组。每条带原文链接（按标题匹配回 RSS 条目）。 ——
// 只把字符串数组当列表用：模型有时把 titles 给成单个字符串或对象
const asStrList = v => (Array.isArray(v) ? v.map(String) : typeof v === 'string' && v.trim() ? [v] : []);

export async function digestNews(items, {model} = {}) {
  if (!aiEnabled()) throw newsError(501, 'AI 未启用：热点日报需要 AI 汇总');
  const list = items.map((it, i) => `${i + 1}. ${it.title}${it.summary ? '｜' + it.summary.slice(0, 80) : ''}`).join('\n');
  const useModel = model || TASK_MODELS.news;

  // 综述单独一次「纯文本」请求：JSON + 多字段的提示词下，模型经常把键名换成中文或
  // 干脆只给主题分组（实测 glm-5.3-flash 同一提示词三种输出），结果日报写成空综述。
  // 纯文本没有键名可漂移，服从度最高；主题分组再单独要 JSON，失败也只损失分组。
  const rawDigest = await chat([
    {role: 'system', content: '你是 AI 行业动态的编辑。只输出一段中文综述正文，150-220 字，不要标题、不要列表、不要 JSON、不要任何前缀说明。'},
    {role: 'user', content: `把这些 AI 动态写成一段综述，突出最重要的一两件事：\n\n${list.slice(0, 7000)}`}
  ], {model: useModel, temperature: 0.2, maxTokens: 1200});
  const digest = cleanDigest(rawDigest);
  if (!digest) throw newsError(502, 'AI 返回的综述是空的，稍后重试或换模型');

  // 主题分组：模型天然爱输出 Markdown（实测让它给 JSON 也照样回「## 主题一：…」），
  // 那就顺着它的强项要 Markdown，再用行首符号解析——不经过 JSON，就没有键名漂移和修复调用。
  let topics = [];
  try {
    const gtext = await chat([
      {role: 'system', content: '你是 AI 行业动态的编辑。只输出被要求的内容，不要解释、不要前言。'},
      {role: 'user', content: `把这些 AI 动态归到 3-6 个主题里，严格按下面格式输出 Markdown，每条只归一个主题，标题逐字照抄：\n\n## 主题名\n- 条目原文标题\n\n动态：\n${list.slice(0, 7000)}`}
    ], {model: useModel, temperature: 0.2, maxTokens: 2000});
    topics = withLinks(parseTopicsMd(gtext), items);
    if (!topics.length) {
      // 万一它还是回了 JSON，再兜一次
      try { topics = withLinks(collectTopics(JSON.parse(gtext), items), items); } catch {}
    }
  } catch (e) {
    console.error('[news] 主题分组生成失败（综述已生成，日报照写）：', e.message);
  }
  return {digest: digest.slice(0, 400), topics};
}

// 模型会在正文前后加「## 本期 AI 动态综述」「好的，以下是…」这类包装：去掉标题行与加粗，
// 拼成一段，再在句末收尾（截断到半句会让综述看起来像坏数据）。
function cleanDigest(text) {
  const lines = String(text || '').replace(/```[a-z]*/gi, '').split(/\r?\n/).map(l => l.trim())
    .filter(l => l && !/^#{1,6}\s/.test(l))
    .map(l => l.replace(/^综述[:：]\s*/u, '').replace(/^[-*•]\s*/, '').replace(/\*\*(.+?)\*\*/g, '$1'));
  let s2 = lines.join(' ').replace(/^(?:好的|当然|以下是)[^。]{0,24}[，,。]?\s*/u, '').trim();
  if (s2.length > 400) {
    const cut = s2.slice(0, 400);
    const stop = Math.max(cut.lastIndexOf('。'), cut.lastIndexOf('！'), cut.lastIndexOf('？'));
    s2 = stop > 120 ? cut.slice(0, stop + 1) : cut + '…';
  }
  return s2;
}

// 解析「## 主题名 / - 标题」这种 Markdown 分组（也容忍「1. 标题」「* 标题」与编号前缀）
function parseTopicsMd(text) {
  const out = [];
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    const head = line.match(/^#{1,6}\s*(.+)$/);
    if (head) { out.push({name: head[1].replace(/^主题[一二三四五六七八九十\d]*[:：]?\s*/, '').trim(), titles: []}); continue; }
    const item = line.match(/^(?:[-*•]|\d+[.)、])\s*(.+)$/);
    if (item && out.length) out[out.length - 1].titles.push(item[1].replace(/^\[(.*?)\]\(.*\)$/, '$1').trim());
  }
  return out.filter(t => t.name && t.titles.length);
}

// 给主题里的标题配上原文链接
function withLinks(list, items) {
  const byTitle = (items || []).map(it => ({t: it.title, link: it.link || ''}));
  const linkOf = title => {
    if (!title) return '';
    const hit = byTitle.find(x => x.t === title) || byTitle.find(x => x.t.includes(title) || title.includes(x.t));
    return hit?.link || '';
  };
  return list.map(t => ({...t, links: t.titles.map(linkOf)}));
}

// 主题分组解析：键名（topics / 主题 / 主题分组 / 分类）、值形态（数组 / {主题名:[标题]} 对象映射）
// 都可能变，逐个试，再全局扫一遍；标题只保留能在原始条目里对上的（对上才能配链接）。
function collectTopics(out, items) {
  const byTitle = items.map(it => ({t: it.title, link: it.link || ''}));
  const linkOf = title => {
    if (!title) return '';
    const hit = byTitle.find(x => x.t === title) || byTitle.find(x => x.t.includes(title) || title.includes(x.t));
    return hit?.link || '';
  };
  const groups = () => {
    for (const k of ['topics', '主题', '主题分组', '分类', 'categories', '分组']) {
      const v = pickKey(out, k);
      if (v) { const t = topicEntries(v); if (t.length) return t; }
    }
    for (const v of Object.values(out || {})) { const t = topicEntries(v); if (t.length) return t; }
    return [];
  };
  return groups().slice(0, 8).map(t => {
    const titles = asArray(pickKey(t, 'titles', '标题', '条目', 'items', 'list')).map(String).map(x => x.trim());
    const list = (titles.length ? titles : firstStrList(t)).filter(Boolean);
    return {
      name: String(pickKey(t, 'name', '主题名', '主题', 'title', '标题', 'group', 'category') || '').slice(0, 40),
      titles: list.slice(0, 12)
    };
  }).filter(t => t.name && t.titles.length).map(t => ({...t, links: t.titles.map(linkOf)}));
}

// 日报的 .md 形态。每条带原文链接（有链接的用 markdown 链接，没有的退回纯文本）。
function renderMd(date, items, {digest, topics}) {
  const body = [
    `## 综述`, '',
    digest, '',
    ...topics.flatMap(t => [`## ${t.name}`, '', ...t.titles.map((x, i) => `- ${t.links?.[i] ? `[${x}](${t.links[i]})` : x}`), '']),
    `---`, '',
    `共 ${items.length} 条原始动态（最近 48 小时）。生成自 [AIHOT](${NEWS_SOURCE}) RSS，由 AI 汇总，可能存在偏差，引用前请核对原文。`
  ].join('\n');
  // 主题名也写进 tags：图谱里不同日期的日报会因共享主题自动靠拢，也能和正文话题对上。
  const tags = ['AI热点', ...topics.map(t => String(t.name || '').trim()).filter(Boolean).slice(0, 6)];
  return writeDoc('', {fm: {tags, date, kind: 'news'}, body});
}

// 生成（或复用）当天的日报。io 注入便于测试：{writeExisting, createNote, mtimeOf, join, readFileSync}
export async function refreshNews(index, vaultDir, io = {}) {
  const date = localDate();
  const cached = index.getNews(date);
  // vault 里文件还在且完整（没被手动删 / 没被写坏）才复用缓存
  const mdPath = join(vaultDir, NEWS_DIR, `${date}.md`);
  if (cached && validMd(mdPath)) return null;
  // 同一天连续失败（磁盘满 / 目录只读 / RSS 长期 5xx / AI 回不出 JSON）时别每 30 分钟再烧一次
  // 完整 AI 汇总。达到上限要走错误码而不是 return null —— null 会被 /api/news/refresh 当成
  // 「今天已生成过」回 200，用户看不到其实当天已经放弃生成。
  if ((attempts.get(date) || 0) >= 3) {
    console.error('[news] 今天的日报已经连续生成失败 3 次，等明天再试');
    throw newsError(503, '今天的日报已连续生成失败 3 次，稍后手动刷新或明天自动重试');
  }

  // 抓 RSS + 调模型这两步才是真正烧钱的部分，失败同样要计数：
  // 只在写盘失败时计数的话，RSS 5xx / AI 非 JSON 会让 cron 每 30 分钟重跑一次完整汇总（一天几十次）。
  let items, r;
  try {
    items = await fetchAiNews();
    if (!items.length) throw newsError(502, 'RSS 里没有可用条目');
    r = await digestNews(items, {model: io.model});
  } catch (e) {
    bumpAttempt(date);
    throw e;
  }
  const payload = {...r, items: items.map(i => ({title: i.title, link: i.link, date: i.date?.toISOString?.() || null})), model: TASK_MODELS.news};

  // 先落 .md，再写 SQLite：反过来的话，写盘失败（ENOSPC / EROFS）会留下「/api/news 有今天这份、
  // vault 里却没有」的分叉，图谱看不到、次日还会重新烧一次完整汇总。
  // 文件已完整存在（比如重启后补写）就跳过，残缺的会重写覆盖。
  if (!validMd(mdPath)) {
    try {
      mkdirSync(dirname(mdPath), {recursive: true});
      writeMdAtomic(mdPath, renderMd(date, items, r));
    } catch (e) {
      bumpAttempt(date);
      throw e;
    }
  }
  index.putNews(date, payload);
  attempts.delete(date);
  return {date, digest: r.digest, topics: r.topics.length, items: items.length};
}

// 强制刷新前的备份：用户可能在 Obsidian 里手改过当天日报（补评论、删误报条目），
// 而「强制」这条路原来是直接整份覆盖、既没 .trash 备份也没有独立 git 提交点。
function backupExisting(vaultDir, rel, abs) {
  try {
    const dst = join(vaultDir, '.trash', rel.replace(/\.md$/i, `-${new Date().toISOString().replace(/[:.]/g, '-')}.md`));
    mkdirSync(dirname(dst), {recursive: true});
    copyFileSync(abs, dst);
  } catch (e) { console.error('[news] 备份旧日报失败：', e.message); }
}

// 手动强制刷新（忽略当天缓存，重新拉取汇总）
export async function forceRefresh(index, vaultDir, io = {}) {
  const date = localDate();
  const items = await fetchAiNews();
  if (!items.length) throw newsError(502, 'RSS 里没有可用条目');
  const r = await digestNews(items, {model: io.model});
  const mdPath = join(vaultDir, NEWS_DIR, `${date}.md`);
  if (existsSync(mdPath)) backupExisting(vaultDir, `${NEWS_DIR}/${date}.md`, mdPath);
  mkdirSync(dirname(mdPath), {recursive: true});
  writeMdAtomic(mdPath, renderMd(date, items, r));
  // clearIdeasAt：日报内容整份换了，旧日报「已自动筛过选题」的标记必须作废，
  // 否则新日报永远轮不到自动筛选题（COALESCE 会把旧标记一直保留）。
  index.putNews(date, {...r, items: items.map(i => ({title: i.title, link: i.link, date: i.date?.toISOString?.() || null})), model: TASK_MODELS.news, clearIdeasAt: true});
  attempts.delete(date);
  return {date, digest: r.digest, topics: r.topics.length, items: items.length};
}

export function listNews(index, limit = 14) { return index.listNews(limit); }

// —— 从热点里筛选题（放进 04-选题池 / 射手座）——
// 思路：把「我的笔记在写什么」（works + notes 的标题与摘要）和今天的新闻条目一起给 AI，
// 让它只挑「和我内容方向相关、能落地」的热点，而不是泛泛的热点榜。
// 返回 {candidates, written}：candidates 是给前端预览的；written 是已直接落盘的（auto 模式）。
export async function ideasFromNews(index, vaultDir, {model, auto = false, io = {}} = {}) {
  const news = index.listNews(1, true)[0];
  if (!news) throw newsError(404, '还没有热点日报：先 POST /api/news/refresh 生成一份');
  // 「SQLite 里最新一行」不等于「今天的日报」：cron 在 NEWS_HOUR 之前、生成失败、或用户删了 .md 时，
  // 拿旧日报筛选题会把 sourceNews 写成旧日期，图谱里选题挂在一个不存在的日报上。
  if (news.date !== localDate()) throw newsError(409, `今天还没有热点日报（最新一份是 ${news.date}）：先 POST /api/news/refresh 生成`);
  if (!validMd(join(vaultDir, NEWS_DIR, `${news.date}.md`))) throw newsError(409, `今天的日报文件不完整或已被删除：${NEWS_DIR}/${news.date}.md`);
  // 幂等闸必须放在 AI 调用之前：放在生成候选之后，cron 与手动同时触发时
  // 两边都会先各调一次模型、各写 3 个选题（第二份还会被重名保护改名成「标题 2」）。
  if (auto && news.ideasAt) return {candidates: [], written: [], skipped: '今天的选题已自动落盘过'};
  const myWorks = [];
  const data = index.allNotes(true);
  for (const n of data) {
    if (n.kind === 'post' || n.kind === 'note') myWorks.push(`【${n.title}】${String(n.body || '').slice(0, 200)}`);
  }
  // 跨日去重：48h 抓取窗口下同一热点会连续两天被选中，落盘时撞名 → 「标题 2」，
  // 图谱里同一个热点挂两个几乎相同的选题。
  const existingIdeas = new Set();
  for (const n of data) if (n.kind === 'idea' && n.title) existingIdeas.add(String(n.title).trim());
  const items = (news.items || []).map(i => `- ${i.title}`).join('\n');
  const out = await chat([
    {role: 'system', content: '你是创作者的选题策划。只输出被要求的内容。输出 JSON：{"ideas":[{"title":"…","platform":"小红书","priority":"高|中|低","note":"选题理由：为什么现在写、和创作者已有内容的关联、切入角度（80字内）","newsTitles":["依据的热点标题"]}]}'},
    {role: 'user', content: `这是创作者已有的内容方向：\n${myWorks.slice(0, 20).join('\n').slice(0, 5000)}\n\n这是今天的 AI 热点：\n${items.slice(0, 6000)}\n\n从热点里挑 3 个最适合这个创作者写的选题：必须能和 ta 已有内容方向接上，不要纯蹭热点；每个选题注明依据了哪几条热点。`}
  ], {json: true, model: model || TASK_MODELS.news, temperature: 0.3, maxTokens: 6000});
  // 标题 → 原文链接（AI 抄标题可能不完全一致，用「包含」兜底）
  const byTitle = (news.items || []).map(it => ({t: it.title, link: it.link || ''}));
  const linkOf = title => {
    if (!title) return '';
    const hit = byTitle.find(x => x.t === title) || byTitle.find(x => x.t.includes(title) || title.includes(x.t));
    return hit?.link || '';
  };
  // 键名兜底同上：模型会回 {"选题":…} / {"topics":[{title,description}]}，只认 out.ideas 时
  // 接口 200 但一条候选都没有（前端表现为「点了没反应」）。
  const candidates = pickList(out, ['ideas', '选题', 'candidates', 'topics']).filter(i => i && typeof i === 'object').slice(0, 5).map(i => {
    const newsTitles = asStrList(pickKey(i, 'newsTitles', '依据的热点', '热点标题', 'news', 'sources')).slice(0, 3);
    return {
      title: String(pickKey(i, 'title', '标题') || '').slice(0, 80),
      platform: ['小红书', 'B站', '公众号', '抖音'].includes(pickKey(i, 'platform', '平台')) ? pickKey(i, 'platform', '平台') : '小红书',
      priority: ['高', '中', '低'].includes(pickKey(i, 'priority', '优先级')) ? pickKey(i, 'priority', '优先级') : '中',
      note: String(pickKey(i, 'note', '理由', '选题理由', 'description', 'angle', '切入点') || longestStr(i, ['title', '标题'])).slice(0, 300),
      sourceNews: news.date,
      newsTitles: newsTitles.length ? newsTitles : firstStrList(i).slice(0, 3),
      newsLinks: newsTitles.map(linkOf).filter(Boolean)
    };
  }).filter(i => i.title);
  if (!auto || !candidates.length) return {candidates, written: []};
  // auto：直接落盘进 04-选题池（复用 createNote 的固定模板，文件名即标题）。
  // 幂等标记必须在落盘**之前**抢好：原来的顺序是全部写盘成功后才记 ideasAt，一旦中途失败
  // （磁盘满 / 目录权限 / 同名冲突）或进程被杀，同日再触发会重新调模型、重新落盘，
  // 重名保护把新题改成「标题 2」——正好变成「攒一堆新题」。
  try { index.putNews(news.date, {...news, ideasAt: new Date().toISOString()}); }
  catch (e) { console.error('[news] 记录选题幂等标记失败：', e.message); }
  const createNote = io.createNote;
  const written = [];
  const fresh = candidates.filter(c => !existingIdeas.has(c.title.trim()));
  for (const [i, c] of fresh.entries()) {
    // 正文保留依据的热点条目与原文链接，frontmatter 记 sourceNews，图谱据此连回日报。
    const sources = c.newsTitles.length
      ? ['', '依据热点：', ...c.newsTitles.map((t, k) => `- ${c.newsLinks?.[k] ? `[${t}](${c.newsLinks[k]})` : t}`)].join('\n')
      : '';
    const body = `${c.note || ''}${sources}`.trim();
    // requestId 让 createNote 的重放缓存兜住「同一份日报重试落盘」：重试不会写出第二份
    const r = createNote('idea', {title: c.title, body, fm: {platform: c.platform, priority: c.priority, status: '待写', note: c.note, sourceNews: news.date}, requestId: `news-idea:${news.date}:${i}`});
    written.push({...c, path: r.path});
  }
  return {candidates, written};
}

// 从缓存条目里建「标题 → 链接」映射（与 digestNews 同一套包含匹配）
// 每小时整点附近检查一次；当天还没有日报且已过 NEWS_HOUR 就生成。
export function startNewsCron(runOnce) {
  let running = false;
  const tick = async () => {
    if (running) return;
    const now = localNow();
    if (now.getUTCHours() < NEWS_HOUR) return;
    running = true;
    try { await runOnce(); console.error('[news] 当日 AI 热点日报已就绪'); }
    catch (e) { console.error('[news] 日报生成失败：', e.message); }
    finally { running = false; }
  };
  setInterval(tick, 30 * 60_000).unref();
  setTimeout(tick, 15_000).unref(); // 启动后稍等片刻先试一次
}

