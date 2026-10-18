// 网页剪藏的抓取与正文提取：只用 Node 自带模块（server 保持零依赖）。
//
// 护栏：
//   * 只允许 http/https；
//   * SSRF 防护：DNS 解析后拒绝环回 / 私网 / 链路本地地址（测试可设 WEB_FETCH_ALLOW_PRIVATE=1 放行）；
//     手动跟随重定向（≤3 次），每一跳都重新做地址复检；
//   * 超时与响应体上限（WEB_FETCH_TIMEOUT / WEB_FETCH_MAX_BYTES）；
//   * 只接受 text/html。
// 已知限制：JS 渲染的页面（SPA）抓到的只是空壳，正文提取可能为空。
import {lookup} from 'node:dns/promises';
import {isIP} from 'node:net';

const TIMEOUT = Number(process.env.WEB_FETCH_TIMEOUT || 20_000);
const MAX_BYTES = Number(process.env.WEB_FETCH_MAX_BYTES || 2 * 1024 * 1024);
const ALLOW_PRIVATE = process.env.WEB_FETCH_ALLOW_PRIVATE === '1';
const UA = 'neural-dashboard/0.7 (personal knowledge clipper)';
const MAX_REDIRECTS = 3;

export class FetchError extends Error {}

// 环回 / 私网 / 链路本地 / 保留段一律拒绝（0.0.0.0/8、10/8、127/8、169.254/16、172.16/12、
// 192.168/16、::1、fc00::/7、fe80::/10 等按前缀判断）。
function isPrivateIp(ip) {
  if (isIP(ip) === 4) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) || (a === 172 && b >= 16 && b < 32) || (a === 192 && b === 168) || a >= 224;
  }
  if (isIP(ip) === 6) {
    const s = ip.toLowerCase().replace(/^0+/, '').replace(/:+$/, '');
    return !s || s.startsWith('1') && s.length === 1 || s.startsWith('fe8') || s.startsWith('fe9') ||
      s.startsWith('fea') || s.startsWith('feb') || s.startsWith('fc') || s.startsWith('fd') || s === '1';
  }
  return true;
}

async function assertPublicHost(hostname) {
  if (ALLOW_PRIVATE) return;
  if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local')) {
    throw new FetchError(`不允许抓取内网地址：${hostname}`);
  }
  if (isIP(hostname)) {
    if (isPrivateIp(hostname)) throw new FetchError(`不允许抓取内网地址：${hostname}`);
    return;
  }
  try {
    const addrs = await lookup(hostname, {all: true, verbatim: true});
    if (!addrs.length || addrs.some(a => isPrivateIp(a.address))) {
      throw new FetchError(`不允许抓取内网地址：${hostname}`);
    }
  } catch (e) {
    if (e instanceof FetchError) throw e;
    throw new FetchError(`域名解析失败：${hostname}`);
  }
}

function assertUrl(url) {
  let u;
  try { u = new URL(url); } catch { throw new FetchError('URL 格式不对'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new FetchError('只允许 http/https 链接');
  return u;
}

// 抓取网页。手动处理重定向，每一跳都复检目标地址（防 302 跳内网）。
export async function fetchPage(url) {
  let current = assertUrl(url);
  for (let hop = 0; ; hop++) {
    await assertPublicHost(current.hostname);
    const res = await fetch(current, {
      redirect: 'manual',
      signal: AbortSignal.timeout(TIMEOUT),
      headers: {'user-agent': UA, accept: 'text/html,application/xhtml+xml;q=0.8,*/*;q=0.5'}
    }).catch(e => { throw new FetchError(e.name === 'TimeoutError' ? `抓取超时（${TIMEOUT / 1000}s）` : `抓取失败：${e.message}`); });
    if ([301, 302, 303, 307, 308].includes(res.status)) {
      const loc = res.headers.get('location');
      if (!loc) throw new FetchError(`重定向缺少目标（HTTP ${res.status}）`);
      if (hop >= MAX_REDIRECTS) throw new FetchError('重定向次数过多');
      current = assertUrl(new URL(loc, current).href);
      continue;
    }
    if (!res.ok) throw new FetchError(`抓取失败：HTTP ${res.status}`);
    const type = String(res.headers.get('content-type') || '');
    if (!/text\/html|application\/xhtml/i.test(type)) throw new FetchError(`只支持网页（HTML），实际类型：${type.split(';')[0] || '未知'}`);
    const len = Number(res.headers.get('content-length') || 0);
    if (len > MAX_BYTES) throw new FetchError(`页面过大（${(len / 1024 / 1024).toFixed(1)} MB，上限 ${(MAX_BYTES / 1024 / 1024).toFixed(0)} MB）`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_BYTES) throw new FetchError(`页面过大（上限 ${(MAX_BYTES / 1024 / 1024).toFixed(0)} MB）`);
    const charset = /charset=([\w-]+)/i.exec(type)?.[1] || 'utf-8';
    return {url: current.href, html: buf.toString(charset.includes('gb') ? 'latin1' : 'utf-8')};
  }
}

// —— HTML → 纯文本（零依赖，尽力而为）——
const ENTITIES = {'&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&apos;': "'", '&nbsp;': ' ', '&hellip;': '…', '&mdash;': '—', '&ndash;': '–', '&ldquo;': '「', '&rdquo;': '」', '&lsquo;': '『', '&rsquo;': '』'};
const decodeEntities = s => String(s)
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => { try { return String.fromCodePoint(parseInt(h, 16)); } catch { return ' '; } })
  .replace(/&#(\d+);/g, (_, d) => { try { return String.fromCodePoint(Number(d)); } catch { return ' '; } })
  .replace(/&(amp|lt|gt|quot|#39|apos|nbsp|hellip|mdash|ndash|ldquo|rdquo|lsquo|rsquo);/g, m => ENTITIES[m] || ' ');
const squeeze = s => s.replace(/[ \t ]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();

export function htmlTitle(html) {
  const m = String(html).match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m ? squeeze(decodeEntities(m[1].replace(/<[^>]+>/g, ' '))).slice(0, 120) : '';
}

// 提取正文：优先 article / main，退回 body；块级标签转换行，剥掉脚本样式与导航噪音。
export function htmlToText(html) {
  let s = String(html);
  s = s.replace(/<!--[\s\S]*?-->/g, ' ');
  s = s.replace(/<(script|style|noscript|svg|iframe|template)[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ');
  s = s.replace(/<(nav|header|footer|aside|form)[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ');
  const main = s.match(/<(article|main)[^>]*>([\s\S]*?)<\/\1\s*>/i);
  if (main && main[2].replace(/<[^>]+>/g, '').trim().length > 200) s = main[2];
  else {
    const body = s.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
    if (body) s = body[1];
  }
  s = s.replace(/<(br|hr)\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|section|article|li|tr|h[1-6]|blockquote|pre)\s*>/gi, '\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<[^>]+>/g, ' ');
  return squeeze(decodeEntities(s)).slice(0, 40000);
}
