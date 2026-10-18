// 平台数据同步：发布后把平台侧指标尽力拉回 vault。
//
// 设计（与 news.mjs 同一套思路）：
//   * vault .md 的 frontmatter 是唯一真相；拉到的指标直接写回 .md，乐观锁 / 备份 /
//     git commit 由注入的 writeExisting 兜底，SQLite 不加新表。
//   * 平台发布 API 需要企业资质，个人拿不到 —— 发布本身永远是人工的；这里只做
//     「发布之后」的数据回链：能自动拉的只有公众号（WECHAT_APPID / WECHAT_SECRET），
//     小红书 / 抖音 / B 站个人号没有可用数据接口，标记 pullable:false，指标在面板手动补填。
//   * 键名优先复用文件里已有的键（中英文都认），避免同一语义出现两行。
//
// 环境变量：WECHAT_APPID / WECHAT_SECRET（公众号）、SYNC_HOUR（默认 21 点）、
// PLATFORM_SYNC_CRON=0 关闭定时任务。
import {readFileSync, existsSync} from 'node:fs';
import {join} from 'node:path';
import {parse, pick} from './vault.mjs';

const SYNC_HOUR = Number(process.env.SYNC_HOUR || 21);
const WECHAT_APPID = process.env.WECHAT_APPID || '';
const WECHAT_SECRET = process.env.WECHAT_SECRET || '';

// 拉取能力注册表：platform 键与前端 publish.js 的 PLATFORMS 名称对齐。
export const PLATFORM_PULLABLE = {
  公众号: {pullable: !!WECHAT_APPID && !!WECHAT_SECRET, note: '需要服务端配置 WECHAT_APPID / WECHAT_SECRET'},
  小红书: {pullable: false, note: '个人号没有可用的数据接口，请在看板手动补填指标'},
  抖音: {pullable: false, note: '个人号没有可用的数据接口，请在看板手动补填指标'},
  B站: {pullable: false, note: '个人号没有可用的数据接口，请在看板手动补填指标'}
};

export const platformInfo = () => ({
  pull: Object.fromEntries(Object.entries(PLATFORM_PULLABLE).map(([k, v]) => [k, {pullable: v.pullable, note: v.note}])),
  syncHour: SYNC_HOUR
});

export const pullableOf = name => PLATFORM_PULLABLE[name]?.pullable === true;

// —— 公众号 stable_token（缓存到过期前 5 分钟） ——
let wxToken = {token: '', expires: 0};
async function wechatToken() {
  if (!WECHAT_APPID || !WECHAT_SECRET) throw new Error('未配置 WECHAT_APPID / WECHAT_SECRET');
  if (wxToken.token && Date.now() < wxToken.expires) return wxToken.token;
  const res = await fetch('https://api.weixin.qq.com/cgi-bin/stable_token', {
    method: 'POST', headers: {'content-type': 'application/json'},
    body: JSON.stringify({grant_type: 'client_credential', appid: WECHAT_APPID, secret: WECHAT_SECRET})
  });
  const j = await res.json().catch(() => ({}));
  if (!j.access_token) throw new Error('公众号 token 获取失败：' + (j.errmsg || 'HTTP ' + res.status));
  wxToken = {token: j.access_token, expires: Date.now() + (Number(j.expires_in) - 300) * 1000};
  return wxToken.token;
}

// 公众号数据统计接口的时间范围是 T-1：查最近 3 天，取「已发表图文」汇总里
// 与文章匹配的最新一条。platformId 精确匹配优先，退回按日期取最新（单篇文章场景够用）。
const ymd = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

async function fetchWxMetrics({platformId, url}, {fetchImpl = fetch} = {}) {
  const token = await wechatToken();
  let matched = null;
  for (let i = 1; i <= 3 && !matched; i++) {
    const day = new Date(Date.now() - i * 86400_000);
    const begin = ymd(day), end = ymd(new Date(day.getTime() + 86400_000));
    const res = await fetchImpl(`https://api.weixin.qq.com/datacube/getarticletotal?access_token=${encodeURIComponent(token)}`, {
      method: 'POST', headers: {'content-type': 'application/json'},
      body: JSON.stringify({begin_date: begin, end_date: end})
    });
    const j = await res.json().catch(() => ({}));
    if (!Array.isArray(j.list)) continue;
    for (const item of j.list) {
      const details = item.details || [];
      const stat = details[details.length - 1] || item;
      if (platformId && String(item.url || '').includes(platformId)) { matched = stat; break; }
      if (!platformId && item.url && url && String(item.url).includes(String(url).replace(/^https?:\/\//, '').split('?')[0].slice(0, 40))) { matched = stat; break; }
    }
  }
  return matched;
}

// 把平台指标写回一篇作品。io 注入 writeExisting / mtimeOf，便于测试与避免与 index.mjs 循环引用。
export async function pullOne(post, rel, vaultDir, io = {}) {
  const {writeExisting, mtimeOf} = io;
  const platform = post.platform;
  if (!platform) return {pullable: false, updated: false, error: '作品没有 platform'};
  const cfg = PLATFORM_PULLABLE[platform];
  if (!cfg?.pullable) return {pullable: false, updated: false, error: cfg?.note || '该平台不支持自动拉取'};
  let metrics;
  try { metrics = await fetchWxMetrics(post); }
  catch (e) { return {pullable: true, updated: false, error: e.message}; }
  if (!metrics) return {pullable: true, updated: false, error: '平台侧最近 3 天没有返回数据'};
  const abs = join(vaultDir, rel);
  const before = readFileSync(abs, 'utf8');
  const num = v => (v == null || isNaN(Number(v)) ? undefined : Math.round(Number(v) * 10) / 10);
  const fm = {};
  // 键名复用：文件里已有中文键（观看）就沿用中文，否则写英文键
  const {fm: existing} = parse(before);
  const names = Object.keys(existing);
  const keyName = (key, aliases) => names.find(n => aliases.map(a => a.toLowerCase()).includes(n.toLowerCase())) || key;
  fm[keyName('views', ['views', '观看', '浏览', '阅读', '播放'])] = num(metrics.int_page_read_count);
  fm.syncedAt = `自动 ${ymd(new Date())}`;
  // 公众号数据统计接口只公开阅读类字段；点赞 / 分享 / 收藏等公开细分字段缺失就不写（保留「—」）。
  const patch = Object.fromEntries(Object.entries(fm).filter(([, v]) => v !== undefined));
  if (!Object.keys(patch).length) return {pullable: true, updated: false, error: '平台数据为空'};
  writeExisting(rel, {fm: patch, mtime: mtimeOf(abs)});
  return {pullable: true, updated: true, metrics: patch};
}

// 遍历作品库：有 platform + url 的作品逐篇尝试。io 注入 loadData 风格的数据与写回函数。
export async function pullAll(data, vaultDir, io = {}) {
  const targets = data.works.filter(w => w.post.platform && w.post.url);
  const results = [];
  for (const w of targets) {
    const r = await pullOne(w.post, w.rel, vaultDir, io);
    results.push({path: w.rel, title: w.post.title, platform: w.post.platform, ...r});
  }
  return results;
}

// 每天 SYNC_HOUR 点后每小时检查一次；当天已同步过（任一作品 frontmatter 有今天的 syncedAt）就跳过。
export function startPlatformsCron(runOnce, {intervalMs = 30 * 60_000} = {}) {
  let running = false;
  const tick = async () => {
    if (running) return;
    const now = new Date();
    if (now.getHours() < SYNC_HOUR) return;
    running = true;
    try { await runOnce(); console.error('[platforms] 平台指标同步完成'); }
    catch (e) { console.error('[platforms] 同步失败：', e.message); }
    finally { running = false; }
  };
  setInterval(tick, intervalMs).unref();
  setTimeout(tick, 20_000).unref();
}

// —— 供路由使用的便捷封装：是否存在可拉取能力（未配凭据时 /api/platforms/pull 返回逐篇 pullable:false） ——
export const hasPuller = () => !!WECHAT_APPID && !!WECHAT_SECRET;

// 供读取作品 frontmatter 用（pick 透出，与 vault.mjs 同源）
export {pick};

// 存在性检查（文件可能被外部删除）
export const fileExists = existsSync;
