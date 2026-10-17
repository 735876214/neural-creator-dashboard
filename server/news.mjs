// AI 热点日报（第六星座「AI 热点」的数据）。
//
// 不重复造轮子：热点条目直接消费现成的公开 RSS 源（默认 aihot.news 的「全部 AI 动态」，
// NewsNow 生态；可用 NEWS_SOURCE 换成任何 RSS 2.0 源），本项目只做三件事：
//   1. 拉取 + 解析 + 按 guid 去重；
//   2. 用网关模型把当天的 20-40 条压成一段日报 + 主题分组；
//   3. 写进 vault（00-AI热点/YYYY-MM-DD.md，自动进图谱）和 SQLite（news 表）。
//
// 定时：startNewsCron 每小时检查一次，当天还没有日报且已过 NEWS_HOUR（默认 8 点）就生成。
// 环境变量：NEWS_SOURCE（RSS 地址）、NEWS_HOUR（生成时刻）、NEWS_CRON=0 关闭。
import {writeFileSync, mkdirSync, existsSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {writeDoc} from './frontmatter.mjs';
import {chat, TASK_MODELS, aiEnabled} from './ai.mjs';

const NEWS_SOURCE = process.env.NEWS_SOURCE || 'https://aihot.news/feed/all.xml';
const NEWS_HOUR = Number(process.env.NEWS_HOUR || 8);
const NEWS_DIR = '00-AI热点';
const MAX_ITEMS = 40;

const localDate = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

// —— RSS 2.0 极简解析（只用正则；源是标准 RSS，不值得为此引依赖） ——
const cdata = s => String(s || '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
const stripTags = s => cdata(s).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

export async function fetchAiNews(source = NEWS_SOURCE) {
  const res = await fetch(source, {signal: AbortSignal.timeout(20_000), headers: {'user-agent': 'neural-dashboard/0.6'}});
  if (!res.ok) throw new Error(`RSS 拉取失败：HTTP ${res.status}`);
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

// —— AI 汇总：一段日报 + 主题分组 ——
export async function digestNews(items, {model} = {}) {
  if (!aiEnabled()) throw new Error('AI 未启用：热点日报需要 AI 汇总');
  const list = items.map((it, i) => `${i + 1}. ${it.title}${it.summary ? '｜' + it.summary.slice(0, 80) : ''}`).join('\n');
  const out = await chat([
    {role: 'system', content: '你是 AI 行业动态的编辑。只输出被要求的内容。输出 JSON：{"digest":"200字以内的当日 AI 动态综述","topics":[{"name":"主题名","titles":["属于该主题的条目原文标题"]}]}'},
    {role: 'user', content: `把这些 AI 动态整理成日报：写一段综述（突出最重要的一两件事），再把条目归到 3-6 个主题里（每条只归一个主题，标题用原文）：\n\n${list.slice(0, 7000)}`}
  ], {json: true, model: model || TASK_MODELS.news, temperature: 0.2, maxTokens: 2000});
  return {
    digest: String(out.digest || '').slice(0, 400),
    topics: (out.topics || []).slice(0, 8).map(t => ({
      name: String(t.name || '').slice(0, 40),
      titles: (t.titles || []).map(String).slice(0, 12)
    })).filter(t => t.name && t.titles.length)
  };
}

// 日报的 .md 形态
function renderMd(date, items, {digest, topics}) {
  const body = [
    `## 综述`, '',
    digest, '',
    ...topics.flatMap(t => [`## ${t.name}`, '', ...t.titles.map(x => `- ${x}`), '']),
    `---`, '',
    `共 ${items.length} 条原始动态（最近 48 小时）。生成自 [AIHOT](${NEWS_SOURCE}) RSS，由 AI 汇总，可能存在偏差，引用前请核对原文。`
  ].join('\n');
  return writeDoc('', {fm: {tags: ['AI热点'], date, kind: 'news'}, body});
}

// 生成（或复用）当天的日报。io 注入便于测试：{writeExisting, createNote, mtimeOf, join, readFileSync}
export async function refreshNews(index, vaultDir, io = {}) {
  const date = localDate();
  const cached = index.getNews(date);
  // vault 里文件还在（没被手动删）才复用缓存
  const mdPath = join(vaultDir, NEWS_DIR, `${date}.md`);
  if (cached && existsSync(mdPath)) return null;

  const items = await fetchAiNews();
  if (!items.length) throw new Error('RSS 里没有可用条目');
  const r = await digestNews(items);
  index.putNews(date, {...r, items: items.map(i => ({title: i.title, link: i.link, date: i.date?.toISOString?.() || null})), model: TASK_MODELS.news});

  // 写进 vault（自动进图谱）；文件已存在（比如重启后补写）就跳过
  if (!existsSync(mdPath)) {
    const text = renderMd(date, items, r);
    mkdirSync(dirname(mdPath), {recursive: true});
    writeFileSync(mdPath, text, 'utf8');
  }
  return {date, digest: r.digest, topics: r.topics.length, items: items.length};
}

// 手动强制刷新（忽略当天缓存，重新拉取汇总）
export async function forceRefresh(index, vaultDir, io = {}) {
  const date = localDate();
  const items = await fetchAiNews();
  if (!items.length) throw new Error('RSS 里没有可用条目');
  const r = await digestNews(items);
  index.putNews(date, {...r, items: items.map(i => ({title: i.title, link: i.link, date: i.date?.toISOString?.() || null})), model: TASK_MODELS.news});
  const mdPath = join(vaultDir, NEWS_DIR, `${date}.md`);
  mkdirSync(dirname(mdPath), {recursive: true});
  writeFileSync(mdPath, renderMd(date, items, r), 'utf8');
  return {date, digest: r.digest, topics: r.topics.length, items: items.length};
}

export function listNews(index, limit = 14) { return index.listNews(limit); }

// 每小时整点附近检查一次；当天还没有日报且已过 NEWS_HOUR 就生成。
export function startNewsCron(runOnce) {
  let running = false;
  const tick = async () => {
    if (running) return;
    const now = new Date();
    if (now.getHours() < NEWS_HOUR) return;
    running = true;
    try { await runOnce(); console.error('[news] 当日 AI 热点日报已就绪'); }
    catch (e) { console.error('[news] 日报生成失败：', e.message); }
    finally { running = false; }
  };
  setInterval(tick, 30 * 60_000).unref();
  setTimeout(tick, 15_000).unref(); // 启动后稍等片刻先试一次
}
