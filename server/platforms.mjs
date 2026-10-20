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
// 环境变量：WECHAT_APPID / WECHAT_SECRET（公众号）、SYNC_HOUR（默认 21 点）、SYNC_TZ_OFFSET（默认 8）、
// PLATFORM_SYNC_CRON=0 关闭定时任务。
import {readFileSync, existsSync} from 'node:fs';
import {join} from 'node:path';
import {parse, pick} from './vault.mjs';

const SYNC_HOUR_DEFAULT = Number(process.env.SYNC_HOUR || 21);
// 容器默认 UTC（Dockerfile 不装 tzdata），直接用 getHours() 会让「21:00 后同步」变成北京时间次日 05:00。
// 用显式偏移而不是 TZ 环境变量：不依赖系统 zoneinfo，也不需要 tzdata 包。
const TZ_OFFSET_RAW = Number(process.env.SYNC_TZ_OFFSET);
const TZ_OFFSET = Number.isFinite(TZ_OFFSET_RAW) ? TZ_OFFSET_RAW : 8;
const localNow = (ms = Date.now()) => new Date(ms + TZ_OFFSET * 3600_000);
const WECHAT_APPID_ENV = process.env.WECHAT_APPID || '';
const WECHAT_SECRET_ENV = process.env.WECHAT_SECRET || '';

// 凭据优先级：环境变量 > vault/.dashboard/settings.json 里的平台凭据。
// settings 由看板前端「设置」面板写入；这里每次拉取时现读，改完立即生效，不用重启容器。
// 键名两种都要认：设置面板与 cleanPlatforms 用的是中文键「公众号」，
// 早期版本/手写配置用英文 wechat —— 只认一种就会出现「填了凭据却永远说未配置」。
export function wechatCreds(readSettings) {
  if (WECHAT_APPID_ENV && WECHAT_SECRET_ENV) return {appid: WECHAT_APPID_ENV, secret: WECHAT_SECRET_ENV, from: 'env'};
  const platforms = readSettings()?.platforms || {};
  const wx = platforms['公众号'] || platforms.wechat;
  if (wx?.appid && wx?.secret) return {appid: wx.appid, secret: wx.secret, from: 'settings'};
  return null;
}

// 拉取能力注册表：platform 键与前端 publish.js 的 PLATFORMS 名称对齐。
// 公众号是否可拉取决于「凭据是否配了」（env 或 settings），不能在模块加载时定死。
const credsRef = {readSettings: () => null};
export const bindSettingsReader = fn => { credsRef.readSettings = fn; };
const wxPullable = () => !!wechatCreds(credsRef.readSettings);

export const PLATFORM_PULLABLE = {
  公众号: {pullable: true, note: '凭据来自服务端环境变量或设置面板（WECHAT_APPID / WECHAT_SECRET）'},
  小红书: {pullable: false, note: '个人号没有可用的数据接口，请在看板手动补填指标'},
  抖音: {pullable: false, note: '个人号没有可用的数据接口，请在看板手动补填指标'},
  B站: {pullable: false, note: '个人号没有可用的数据接口，请在看板手动补填指标'}
};

export const platformInfo = () => ({
  pull: Object.fromEntries(Object.entries(PLATFORM_PULLABLE).map(([k, v]) => [k, {
    pullable: k === '公众号' ? wxPullable() : v.pullable,
    note: k === '公众号' && !wxPullable() ? '未配置凭据：在设置面板填公众号 AppID / Secret，或配服务端环境变量' : v.note
  }])),
  syncHour: syncHour(),
  configured: {公众号: wxPullable()}
});

export const pullableOf = name => name === '公众号' ? wxPullable() : PLATFORM_PULLABLE[name]?.pullable === true;
export const syncHour = () => {
  const h = credsRef.readSettings()?.syncHour;
  return Number.isInteger(h) && h >= 0 && h <= 23 ? h : SYNC_HOUR_DEFAULT;
};

// —— 公众号 stable_token（缓存到过期前 5 分钟） ——
let wxToken = {token: '', expires: 0};
async function wechatToken() {
  const creds = wechatCreds(credsRef.readSettings);
  if (!creds) throw new Error('未配置公众号凭据：在设置面板填 AppID / Secret，或配服务端环境变量');
  if (wxToken.token && Date.now() < wxToken.expires && wxToken.appid === creds.appid) return wxToken.token;
  const res = await fetch('https://api.weixin.qq.com/cgi-bin/stable_token', {
    method: 'POST', headers: {'content-type': 'application/json'},
    body: JSON.stringify({grant_type: 'client_credential', appid: creds.appid, secret: creds.secret})
  });
  const j = await res.json().catch(() => ({}));
  if (!j.access_token) throw new Error('公众号 token 获取失败：' + (j.errmsg || 'HTTP ' + res.status));
  wxToken = {token: j.access_token, expires: Date.now() + (Number(j.expires_in) - 300) * 1000, appid: creds.appid};  return wxToken.token;
}

// 公众号数据统计接口的时间范围是 T-1：查最近 3 天，取「已发表图文」汇总里
// 与文章匹配的最新一条。platformId 精确匹配优先，退回按日期取最新（单篇文章场景够用）。
// 传进来的 Date 已经偏移到固定时区，这里统一用 UTC 取值字段。
const ymd = d => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;

async function fetchWxMetrics({platformId, url}, {fetchImpl = fetch} = {}) {
  const token = await wechatToken();
  let matched = null;
  for (let i = 1; i <= 3 && !matched; i++) {
    const day = localNow(Date.now() - i * 86400_000);
    const begin = ymd(day), end = ymd(new Date(day.getTime() + 86400_000));
    const res = await fetchImpl(`https://api.weixin.qq.com/datacube/getarticletotal?access_token=${encodeURIComponent(token)}`, {
      method: 'POST', headers: {'content-type': 'application/json'},
      body: JSON.stringify({begin_date: begin, end_date: end})
    });
    const j = await res.json().catch(() => ({}));
    // 权限/限流类错误（48001 无 datacube 权限、45009 超限、40001 token 失效）必须原样抛出：
    // 当成「没有数据」会让用户反复重试，永远定位不到真正原因。
    if (!res.ok || j.errcode) {
      if (j.errcode === 40001 || j.errcode === 42001) wxToken = {token: '', expires: 0}; // token 失效，下次重取
      throw new Error('公众号数据接口错误：' + (j.errmsg || 'HTTP ' + res.status) + (j.errcode ? `（errcode ${j.errcode}）` : ''));
    }
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
  fm.syncedAt = `自动 ${ymd(localNow())}`;
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
  let lastRunYmd = ''; // 当天跑过就不再跑：否则每 30 分钟全量重拉一次，逐篇产生 git commit 与限流风险
  const tick = async () => {
    if (running) return;
    const now = localNow();
    if (now.getUTCHours() < syncHour()) return;
    const today = ymd(now);
    if (lastRunYmd === today) return;
    running = true;
    try { await runOnce(); lastRunYmd = today; console.error('[platforms] 平台指标同步完成'); }
    catch (e) { console.error('[platforms] 同步失败：', e.message); }
    finally { running = false; }
  };
  setInterval(tick, intervalMs).unref();
  setTimeout(tick, 20_000).unref();
}

// —— 供路由使用的便捷封装：是否存在可拉取能力（未配凭据时 /api/platforms/pull 返回逐篇 pullable:false） ——
export const hasPuller = () => wxPullable();

// 供读取作品 frontmatter 用（pick 透出，与 vault.mjs 同源）
export {pick};

// 存在性检查（文件可能被外部删除）
export const fileExists = existsSync;
