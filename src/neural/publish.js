// 半自动发布：平台创作页清单与「发布就绪包」拼装。
//
// 不调平台发布 API（个人拿不到资质）；流程是：
//   生成发布包 → 同一用户手势内复制到剪贴板 → 打开平台创作页 → 用户手动粘贴发布
//   → 回填链接（url / platformId）写回草稿 frontmatter，发布后的同名作品自动带上来源。
export const PLATFORMS = {
  小红书: {
    url: 'https://creator.xiaohongshu.com/publish/publish',
    zh: '小红书', en: 'REDnote',
    hint: '正文会带上 #话题；注意首图需要在创作页单独上传。',
    build: ({title, body, tags}) => [body, '', ...tags.slice(0, 6).map(t => '#' + t)].join('\n')
  },
  抖音: {
    url: 'https://creator.douyin.com/creator-micro/content/upload',
    zh: '抖音', en: 'Douyin',
    hint: '文案建议 55 字内，标题另填；标签拼在文案末尾。',
    build: ({title, body, tags}) => `${title}\n\n${body.slice(0, 300)}\n\n${tags.slice(0, 4).map(t => '#' + t).join(' ')}`.trim()
  },
  'B站': {
    url: 'https://member.bilibili.com/platform/upload/video/frame',
    zh: 'B站', en: 'bilibili',
    hint: '标题上限 80 字；正文作为视频简介粘贴。',
    build: ({title, body, tags}) => `【${title}】\n\n${body}\n\n${tags.slice(0, 5).map(t => '#' + t).join(' ')}`.trim()
  },
  公众号: {
    url: 'https://mp.weixin.qq.com/',
    zh: '公众号', en: 'WeChat',
    hint: '标题单独粘贴第一行；正文支持自动拉取阅读数据（需服务端配置 WECHAT_APPID/SECRET）。',
    build: ({title, body}) => `${title}\n\n${body}`
  }
};

export const PLATFORM_KEYS = Object.keys(PLATFORMS);
export const platformOf = name => PLATFORMS[name] || null;

// 发布就绪包：标题 + 正文 + 话题，按平台规则拼装。tags 取自作品/草稿的标签节点。
export function buildPack(platform, {title, body, tags = []}) {
  const cfg = platformOf(platform) || PLATFORMS['小红书'];
  const cleanTags = [...new Set((tags || []).map(t => String(t).replace(/^#/, '').trim()).filter(Boolean))];
  const text = cfg.build({title: title || '未命名草稿', body: body || '', tags: cleanTags});
  return {text, hint: cfg.hint, platform};
}

// 降级复制：非安全上下文（http 局域网）里 navigator.clipboard 不存在，退回 textarea + execCommand。
export function copyText(text) {
  if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(text).then(() => true, () => fallbackCopy(text));
  return Promise.resolve(fallbackCopy(text));
}

function fallbackCopy(text) {
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('style', 'position:fixed;left:-9999px;top:0;opacity:0');
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch { return false; }
}
