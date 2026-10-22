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
import {readFileSync, statSync} from 'node:fs';
import {join} from 'node:path';
import {parse} from './vault.mjs';

// SYNC_HOUR 填成 '21:00' / 'abc' 时 Number() 得到 NaN，而 `hours < NaN` 恒假 —— 定时任务会
// 变成「启动即同步」，与「等到 21 点」完全相反。非法值回退默认并留一行日志。
const parsedHour = Number(process.env.SYNC_HOUR);
const SYNC_HOUR_DEFAULT = Number.isFinite(parsedHour) && parsedHour >= 0 && parsedHour <= 23 ? parsedHour : 21;
if (process.env.SYNC_HOUR && SYNC_HOUR_DEFAULT !== parsedHour) console.error(`[platforms] SYNC_HOUR=${process.env.SYNC_HOUR} 不是 0–23 的数字，改用 ${SYNC_HOUR_DEFAULT}`);
// 容器默认 UTC（Dockerfile 不装 tzdata），直接用 getHours() 会让「21:00 后同步」变成北京时间次日 05:00。
// 用显式偏移而不是 TZ 环境变量：不依赖系统 zoneinfo，也不需要 tzdata 包。
const TZ_OFFSET_RAW = Number(process.env.SYNC_TZ_OFFSET);
const TZ_OFFSET = Number.isFinite(TZ_OFFSET_RAW) ? TZ_OFFSET_RAW : 8;
const localNow = (ms = Date.now()) => new Date(ms + TZ_OFFSET * 3600_000);

// 微信侧网络黑洞（NAS 出口被墙 / 对端挂住连接）时 undici 默认要等 300s：同步期间整站 AI 与日报
// 都被同一把闸挡住，30 篇的批量最坏能把闸占几小时。所有外部请求都必须带自己的超时。
const WX_TIMEOUT = 15_000;
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
let wxToken = {token: '', expires: 0, appid: ''};
let wxTokenFailAt = 0; // 取 token 失败后的 60s 冷却：批量同步里每篇都会重试一次，会直接撞 45009
async function wechatToken() {
  const creds = wechatCreds(credsRef.readSettings);
  if (!creds) throw fatalAuth('未配置公众号凭据：在设置面板填 AppID / Secret，或配服务端环境变量');
  if (wxToken.token && Date.now() < wxToken.expires && wxToken.appid === creds.appid) return wxToken.token;
  if (Date.now() - wxTokenFailAt < 60_000) throw fatalAuth('公众号 token 刚刚获取失败，60 秒后再试');
  const res = await fetch('https://api.weixin.qq.com/cgi-bin/stable_token', {
    method: 'POST', headers: {'content-type': 'application/json'},
    body: JSON.stringify({grant_type: 'client_credential', appid: creds.appid, secret: creds.secret}),
    signal: AbortSignal.timeout(WX_TIMEOUT)
  });
  const j = await res.json().catch(() => ({}));
  if (!j.access_token) {
    wxTokenFailAt = Date.now();
    throw fatalAuth('公众号 token 获取失败：' + (j.errmsg || 'HTTP ' + res.status));
  }
  wxToken = {token: j.access_token, expires: Date.now() + (Number(j.expires_in) - 300) * 1000, appid: creds.appid};
  return wxToken.token;
}

// 凭据 / token 类失败是整批共有的：单篇吞掉它会让批量同步退化成「3 天窗口 × N 篇各自换一次 token」，
// 直接把微信侧的取 token 频率限制撞穿，而用户只看到 N 条一样的错。用标记让上层中止整批。
function fatalAuth(message) {
  const e = new Error(message);
  e.fatal = 'auth';
  return e;
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
    // end_date 只能到「昨日」：原来写成 day+1 天等于查今天，官方对未出数据的日期直接回空，
    // 于是每一天都白查一次、匹配永远落空。
    const begin = ymd(day), end = begin;
    const res = await fetchImpl(`https://api.weixin.qq.com/datacube/getarticletotal?access_token=${encodeURIComponent(token)}`, {
      method: 'POST', headers: {'content-type': 'application/json'},
      body: JSON.stringify({begin_date: begin, end_date: end}),
      signal: AbortSignal.timeout(WX_TIMEOUT)
    });
    const j = await res.json().catch(() => ({}));
    // 权限/限流类错误（48001 无 datacube 权限、45009 超限、40001 token 失效）必须原样抛出：
    // 当成「没有数据」会让用户反复重试，永远定位不到真正原因。
    if (!res.ok || j.errcode) {
      // token / 权限类错误是整批共有的：标成 fatal，让调用方中止整批而不是逐篇重取 token。
      if (j.errcode === 40001 || j.errcode === 42001) {
        wxToken = {token: '', expires: 0, appid: ''};
        throw fatalAuth('公众号 token 已失效：' + (j.errmsg || '请重新获取'));
      }
      if (j.errcode === 48001 || j.errcode === 45009 || j.errcode === 40013) {
        throw fatalAuth('公众号数据接口错误：' + (j.errmsg || 'HTTP ' + res.status) + (j.errcode ? `（errcode ${j.errcode}）` : ''));
      }
      // access_token 在 URL query 上：错误文本里绝不能把整条 URL 打进去（会跟着 job.error 回浏览器）
      const detail = String(j.errmsg || 'HTTP ' + res.status).replace(/access_token=[^&\s]+/g, 'access_token=***');
      throw new Error('公众号数据接口错误：' + detail + (j.errcode ? `（errcode ${j.errcode}）` : ''));
    }
    if (!Array.isArray(j.list)) continue;
    for (const item of j.list) {
      const details = item.details || [];
      const stat = details[details.length - 1] || item;
      // getarticletotal 的条目只有 ref_date / msgid / title / details，**没有 url 字段**：
      // 原来按 `item.url.includes(platformId)` 匹配，matched 恒为 null，公众号同步整条链路不工作。
      // 作品的 platformId 回填的就是 msgid，按它精确匹配；没有 platformId 时退化成「窗口内最新一篇」。
      const msgid = String(item.msgid || '').trim();
      if (platformId) {
        if (msgid && msgid === String(platformId).trim()) { matched = stat; break; }
      } else {
        matched = stat;
        break;
      }
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
  // 公众号的 pullable 是静态 true，真正的开关在凭据上：没配凭据时要说「没配」，不能逐篇报
  // 「失败 N 次」——前端会把「3 篇失败：未配置凭据」当成同步出错。
  if (platform === '公众号' && !wxPullable()) {
    return {pullable: false, updated: false, error: '未配置凭据：在设置面板填公众号 AppID / Secret，或配服务端环境变量'};
  }
  if (!cfg?.pullable) return {pullable: false, updated: false, error: cfg?.note || '该平台不支持自动拉取'};
  let metrics;
  try { metrics = await fetchWxMetrics(post); }
  catch (e) {
    // 凭据 / token 类是整批共有的失败：原样上抛，让 pullAll 与路由立刻中止整批
    if (e.fatal) throw e;
    return {pullable: true, updated: false, error: e.message};
  }
  if (!metrics) return {pullable: true, updated: false, error: '平台侧最近 3 天没有返回数据'};
  const abs = join(vaultDir, rel);
  // 读文本与取 mtime 必须贴着写回：这里现取 mtime，writeExisting 的乐观锁才真的能拦住
  // 「拉取期间别处改了这篇」。文件在此期间被外部删除/改名时报可读原因，不能让整批中断。
  let before = '';
  let mtime = null;
  try {
    mtime = mtimeOf(abs);
    before = readFileSync(abs, 'utf8');
  } catch (e) {
    return {pullable: true, updated: false, error: '读取作品失败：' + (e.code === 'ENOENT' ? '文件已不存在' : e.message)};
  }
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
  writeExisting(rel, {fm: patch, mtime});
  return {pullable: true, updated: true, metrics: patch};
}

// 遍历作品库：有 platform + url 的作品逐篇尝试。
// 单篇失败只记录在 results 里，不中断整批；但 fatal（凭据 / token）会立刻中止并把原因带回。
export async function pullAll(data, vaultDir, io = {}) {
  const targets = data.works.filter(w => w.post.platform && w.post.url);
  const results = [];
  for (const w of targets) {
    try {
      const r = await pullOne(w.post, w.rel, vaultDir, io);
      results.push({path: w.rel, title: w.post.title, platform: w.post.platform, ...r});
    } catch (e) {
      if (e.fatal) return {results, aborted: true, error: e.message};
      results.push({path: w.rel, title: w.post.title, platform: w.post.platform, pullable: true, updated: false, error: e.message});
    }
  }
  return {results, aborted: false};
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
    try {
      // runOnce 返回 {ok, failed, aborted}：全部失败或凭据类中止时**不能**置 lastRunYmd ——
      // 否则当天剩余 20 多次 tick 全被跳过，一整天不再同步，日志里只剩一行「同步失败」。
      const stats = await runOnce();
      const ok = Number(stats?.ok) || 0;
      const failed = Number(stats?.failed) || 0;
      if (stats?.aborted) {
        console.error(`[platforms] 同步被凭据类错误中止（${ok} 篇更新 / ${failed} 篇失败），等下一次重试`);
      } else if (ok > 0 || failed === 0) {
        lastRunYmd = today;
        console.error(`[platforms] 平台指标同步完成：${ok} 篇更新，${failed} 篇失败`);
      } else {
        console.error(`[platforms] 平台指标同步全部失败（${failed} 篇），等下一次重试`);
      }
    } catch (e) { console.error('[platforms] 同步失败：', e.message); }
    finally { running = false; }
  };
  setInterval(tick, intervalMs).unref();
  setTimeout(tick, 20_000).unref();
}

// —— 供路由使用的便捷封装：是否存在可拉取能力（未配凭据时 /api/platforms/pull 返回逐篇 pullable:false） ——
