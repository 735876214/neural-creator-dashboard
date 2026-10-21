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
import http from 'node:http';
import https from 'node:https';

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
    const s = ip.toLowerCase();
    // IPv4 映射 / 兼容地址（::ffff:127.0.0.1、::127.0.0.1）实质是 IPv4：剥出来按 IPv4 判。
    // 不剥的话它们既不以 fe8/fc/fd 开头、也不是「IPv4 字面量」，会被当成公网放行。
    const mapped = s.match(/^::(?:ffff:)?(\d{1,3}(?:\.\d{1,3}){3})$/);
    if (mapped) return isPrivateIp(mapped[1]);
    if (s === '::' || s === '::1') return true; // 未指定 / 环回
    const head = parseInt(s.split(':')[0], 16);
    // 白名单式判断：只有全球单播 2000::/3 放行；ULA fc00::/7、链路本地 fe80::/10、
    // 组播 ff00::/8 等一律拒绝。解析不出首段时 head 是 NaN，落进拒绝分支。
    return !(head >= 0x2000 && head <= 0x3fff);
  }
  return true;
}

// 去掉 IPv6 字面量的方括号：new URL('http://[::1]/').hostname 是 '[::1]'（带括号），
// isIP('[::1]') 返回 0，于是被当成域名去 lookup，报「域名解析失败」。
const bareHost = h => (h.startsWith('[') && h.endsWith(']') ? h.slice(1, -1) : h);

async function resolvePublic(host, {family = 0, all = false} = {}) {
  const addrs = await lookup(host, {all: true, verbatim: true});
  const ok = addrs.filter(a => (!family || a.family === family) && !isPrivateIp(a.address));
  if (!ok.length) throw new FetchError(`不允许抓取内网地址：${host}`);
  return all ? ok : ok[0];
}

async function assertPublicHost(hostname) {
  if (ALLOW_PRIVATE) return;
  const host = bareHost(hostname);
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) {
    throw new FetchError(`不允许抓取内网地址：${host}`);
  }
  if (isIP(host)) {
    if (isPrivateIp(host)) throw new FetchError(`不允许抓取内网地址：${host}`);
    return;
  }
  try {
    await resolvePublic(host);
  } catch (e) {
    if (e instanceof FetchError) throw e;
    throw new FetchError(`域名解析失败：${host}`);
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
    const res = await requestOnce(current, {
      'user-agent': UA,
      accept: 'text/html,application/xhtml+xml;q=0.8,*/*;q=0.5'
    });
    if ([301, 302, 303, 307, 308].includes(res.status)) {
      const loc = res.headers.location;
      if (!loc) throw new FetchError(`重定向缺少目标（HTTP ${res.status}）`);
      if (hop >= MAX_REDIRECTS) throw new FetchError('重定向次数过多');
      current = assertUrl(new URL(loc, current).href);
      continue;
    }
    if (res.status < 200 || res.status >= 300) throw new FetchError(`抓取失败：HTTP ${res.status}`);
    const type = String(res.headers['content-type'] || '');
    if (!/text\/html|application\/xhtml/i.test(type)) throw new FetchError(`只支持网页（HTML），实际类型：${type.split(';')[0] || '未知'}`);
    const charset = (/charset=([\w-]+)/i.exec(type)?.[1] || 'utf-8').toLowerCase();
    // 原来把 GB 系页面按 latin1 解，产出的是拉丁乱码；utf-16 当 utf-8 解也是乱码。
    // 宁可不入库，也不要往知识库里写一坨乱码。
    if (/^(gb|gbk|gb2312|gb18030|big5|utf-16|utf-16le|utf-16be)/.test(charset)) {
      throw new FetchError(`暂不支持该编码的页面：${charset}`);
    }
    return {url: current.href, html: res.buf.toString('utf-8')};
  }
}

// 单次请求：把 SSRF 复检塞进**真正建立连接的那一次 DNS 解析**（lookup 钩子），
// 而不是先 lookup 判私网再 fetch。后者是两次独立解析，攻击者用 TTL 0 的域名在
// 两次之间换答案，就能让连接落到 127.0.0.1 / 内网 NAS（DNS rebinding / TOCTOU）。
// 响应体边读边计数，超过上限立刻断开——原来的 arrayBuffer() 会先把整包读进内存再比对。
function requestOnce(u, headers) {
  const mod = u.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (fn, v) => { if (!settled) { settled = true; fn(v); } };
    const req = mod.request(u, {
      method: 'GET',
      headers,
      timeout: TIMEOUT,
      lookup(host, opts, cb) {
        if (ALLOW_PRIVATE) return cb(null, host, 4);
        resolvePublic(bareHost(host), {family: opts?.family || 0, all: opts?.all === true})
          .then(r => (opts?.all ? cb(null, r) : cb(null, r.address, r.family)))
          .catch(e => cb(e instanceof FetchError ? e : new FetchError(`域名解析失败：${host}`)));
      }
    }, res => {
      const len = Number(res.headers['content-length'] || 0);
      if (len > MAX_BYTES) {
        res.destroy();
        return done(reject, new FetchError(`页面过大（${(len / 1024 / 1024).toFixed(1)} MB，上限 ${(MAX_BYTES / 1024 / 1024).toFixed(0)} MB）`));
      }
      const chunks = [];
      let n = 0;
      res.on('data', c => {
        n += c.length;
        if (n > MAX_BYTES) {
          res.destroy();
          done(reject, new FetchError(`页面过大（上限 ${(MAX_BYTES / 1024 / 1024).toFixed(0)} MB）`));
          return;
        }
        chunks.push(c);
      });
      res.on('end', () => done(resolve, {status: res.statusCode, headers: res.headers, buf: Buffer.concat(chunks)}));
      res.on('error', e => done(reject, new FetchError(`抓取失败：${e.message}`)));
    });
    req.on('timeout', () => req.destroy(new FetchError(`抓取超时（${TIMEOUT / 1000}s）`)));
    req.on('error', e => done(reject, e instanceof FetchError ? e : new FetchError(`抓取失败：${e.message}`)));
    req.end();
  });
}

// —— HTML → 纯文本（零依赖，尽力而为）——
const ENTITIES = {'&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&apos;': "'", '&nbsp;': ' ', '&hellip;': '…', '&mdash;': '—', '&ndash;': '–', '&ldquo;': '「', '&rdquo;': '」', '&lsquo;': '『', '&rsquo;': '』'};
const decodeEntities = s => String(s)
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => { try { return String.fromCodePoint(parseInt(h, 16)); } catch { return ' '; } })
  .replace(/&#(\d+);/g, (_, d) => { try { return String.fromCodePoint(Number(d)); } catch { return ' '; } })
  .replace(/&(amp|lt|gt|quot|#39|apos|nbsp|hellip|mdash|ndash|ldquo|rdquo|lsquo|rsquo);/g, m => ENTITIES[m] || ' ');
const squeeze = s => s.replace(/[ \t ]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();

export function htmlTitle(html) {
  const s = String(html);
  // og:title（或 twitter:title）优先：微信推文的 <title> 是「标题+账号名」长串，og:title 才是纯标题。
  const meta = s.match(/<meta[^>]+property=["'](?:og:title|twitter:title)["'][^>]*content=["']([^"']*)["']/i)
    || s.match(/<meta[^>]+content=["']([^"']*)["'][^>]*property=["'](?:og:title|twitter:title)["']/i);
  if (squeeze(meta?.[1] || '')) return squeeze(decodeEntities(meta[1])).slice(0, 120);
  const m = s.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
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

