/**
 * 视频区域启发式：只做纯函数判断，状态机在 index.js。
 * 判断顺序：进程名/窗口类 → 标题关键词 → 全屏（无标题栏且覆盖≥90%显示器）或浏览器内 16:9 推算。
 */

const WS_CAPTION = 0x00c00000;

/** 进程名归一：去 .exe，转小写。 */
export function normalizeExe(exeName) {
  return String(exeName ?? '')
    .trim()
    .toLowerCase()
    .replace(/\.exe$/, '');
}

export function matchBrowser({ exeName, className }, videoConfig = {}) {
  const exe = normalizeExe(exeName);
  const browsers = Array.isArray(videoConfig.browsers) ? videoConfig.browsers.map(normalizeExe) : [];
  if (exe && browsers.includes(exe)) return true;
  // 窗口类只作为「读不到进程名」时的兜底：Chrome_WidgetWin_1 / MozillaWindowClass 也被
  // 大量 Electron 应用使用（VS Code、Slack…），若无条件接受会把它们误判成浏览器。
  if (!exe) {
    const cls = String(className ?? '').trim();
    if (cls === 'Chrome_WidgetWin_1' || cls === 'MozillaWindowClass') return true;
  }
  return false;
}

export function matchTitle(title, videoConfig = {}) {
  const lower = String(title ?? '').toLowerCase();
  if (!lower) return false;
  const titles = Array.isArray(videoConfig.titles) ? videoConfig.titles : [];
  return titles.some((needle) => {
    const n = String(needle ?? '').trim().toLowerCase();
    return n.length > 0 && lower.includes(n);
  });
}

/** 自身窗口/配置排除项：标题子串命中即排除。 */
export function isExcluded({ title, exeName }, config = {}) {
  const exe = normalizeExe(exeName);
  if (exe === 'coopanion') return true;
  const haystack = String(title ?? '').toLowerCase();
  const list = [...(Array.isArray(config.excludeTitles) ? config.excludeTitles : [])];
  if (Array.isArray(config.video?.excludeTitles)) list.push(...config.video.excludeTitles);
  return list.some((needle) => {
    const n = String(needle ?? '').trim().toLowerCase();
    return n.length > 0 && haystack.includes(n);
  });
}

/**
 * @param {{title:string, exeName:string, className:string, rect:{x:number,y:number,width:number,height:number}|null,
 *          style?:number|null, monitor?:{full:{x,y,width,height}, work:{x,y,width,height}}|null}} windowInfo
 * @param {object} config 世界配置
 * @returns {null | {title:string, exe:string, fullscreen:boolean, source:'fullscreen'|'heuristic',
 *                   rect:{x:number,y:number,width:number,height:number}, content:{x,y,width,height}}}
 */
export function detectVideo(windowInfo, config = {}) {
  const video = config.video && typeof config.video === 'object' ? config.video : {};
  const rect = windowInfo?.rect;
  if (!rect || rect.width <= 0 || rect.height <= 0) return null;
  // fg 里进程名在 exe/exeName 两种字段都可能出现，这里统一取。
  const exeName = windowInfo?.exeName ?? windowInfo?.exe;
  const info = { title: windowInfo?.title, exeName, className: windowInfo?.className };
  if (!matchBrowser(info, video)) return null;
  if (!matchTitle(info.title, video)) return null;
  if (isExcluded(info, config)) return null;

  const style = windowInfo.style;
  const borderless = typeof style === 'number' ? (style & WS_CAPTION) === 0 : false;
  const coverage = video.fullscreenCoverage > 0 ? Number(video.fullscreenCoverage) : 0.9;
  // monitor 兼容两种形状：{width,height,...}（win32.displayAt）或 {full:{...}}（测试夹具）。
  const monitor = windowInfo.monitor?.full ?? windowInfo.monitor ?? null;
  const coversMonitor =
    monitor && monitor.width > 0 && monitor.height > 0
      ? (rect.width * rect.height) / (monitor.width * monitor.height) >= coverage
      : false;

  const title = String(info.title ?? '');
  const exe = normalizeExe(exeName);

  if (borderless && coversMonitor) {
    return {
      title,
      exe,
      fullscreen: true,
      source: 'fullscreen',
      rect: { ...rect },
      content: { ...rect },
    };
  }

  // 浏览器窗口：内容区 = 窗口减去标签栏/地址栏高度，视频按 16:9 顶部居中。
  const chromeTop = numOr(video.chromeTop, 88);
  const chromeSide = numOr(video.chromeSide, 12);
  const chromeBottom = numOr(video.chromeBottom, 0);
  const content = {
    x: rect.x + chromeSide,
    y: rect.y + chromeTop,
    width: Math.max(0, rect.width - chromeSide * 2),
    height: Math.max(0, rect.height - chromeTop - chromeBottom),
  };
  if (content.width < 80 || content.height < 45) return null;

  let width = content.width;
  let height = (width * 9) / 16;
  if (height > content.height) {
    height = content.height;
    width = (height * 16) / 9;
  }
  width = Math.floor(width);
  height = Math.floor(height);
  const x = Math.round(content.x + (content.width - width) / 2);
  const y = Math.round(content.y);
  const bottom = Math.min(y + height, content.y + content.height);
  return {
    title,
    exe,
    fullscreen: false,
    source: 'heuristic',
    rect: { x, y, width, height: Math.max(0, bottom - y) },
    content,
  };
}

function numOr(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}
