/**
 * Win32 只读探测层（koffi 绑定）。World 运行在 Coopanion 的 Core 进程里，这里只读取
 * 前台窗口、窗口矩形、显示器工作区、空闲时间和按键状态，不改任何系统设置。
 *
 * 注意：这里刻意 **不** 调用 SetProcessDpiAwarenessContext —— 那会改掉整个 Core 进程的
 * DPI 感知模式，属于副作用。坐标按 Windows 交给本进程的虚拟化结果处理；100% 显示时
 * 1 像素 == 1 DIP。非 100% 显示的机器请在配置里设置 `scale`（见 README）。
 *
 * 机密性：只读窗口标题、类名、进程名和矩形；永远不读输入内容，也不碰键位字符。
 */
let api = null;
let loadError = null;

try {
  const koffi = (await import('koffi')).default;
  api = build(koffi);
} catch (error) {
  loadError = error;
}

/* ------------------------------------------------------------------ 常量 */

const GWL_STYLE = -16;
const GWL_EXSTYLE = -20;
const WS_EX_TOOLWINDOW = 0x00000080;
const WS_CAPTION = 0x00c00000;
const WS_MAXIMIZE = 0x01000000;
const SPI_GETWORKAREA = 0x0030;
const DWMWA_EXTENDED_FRAME_BOUNDS = 9;
const DWMWA_CLOAKED = 14;
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;

/**
 * 会触发「打字」判定的虚拟键：可打印字符 + 退格 + 空格 + 小键盘数字。
 * 方向键、功能键、修饰键故意不列（读网页/按 F11 不算打字）。
 */
export const POLL_VKS = [
  0x08, // Backspace
  0x20, // Space
  ...range(0x30, 0x5a), // 0-9、A-Z
  ...range(0x60, 0x6f), // 小键盘 0-9 与运算键
  ...range(0xba, 0xde), // ; = , - . / ` [ \ ] '
];

function range(from, to) {
  const out = [];
  for (let v = from; v <= to; v += 1) out.push(v);
  return out;
}

/** koffi 是否加载成功；失败时整个 World 仍然挂着，工具返回错误字符串。 */
export function available() {
  return loadError === null && api !== null;
}

/** 加载失败原因（英文短句），成功时为 null。 */
export function loadFailure() {
  return loadError ? String(loadError?.message ?? loadError) : null;
}

function use() {
  if (!api) throw new Error(`win32 helper unavailable: ${loadFailure() ?? 'koffi not loaded'}`);
  return api;
}

/* --------------------------------------------------------------- 绑定实现 */

function build(koffi) {
  const user32 = koffi.load('user32.dll');
  const kernel32 = koffi.load('kernel32.dll');
  const dwmapi = koffi.load('dwmapi.dll');
  const gdi32 = koffi.load('gdi32.dll');

  koffi.alias('HANDLE', 'void *');
  koffi.alias('HWND', 'HANDLE');

  const RECT = koffi.struct('RECT', { left: 'long', top: 'long', right: 'long', bottom: 'long' });
  const MONITORINFO = koffi.struct('MONITORINFO', {
    cbSize: 'uint32_t',
    rcMonitor: RECT,
    rcWork: RECT,
    dwFlags: 'uint32_t',
  });
  const LASTINPUTINFO = koffi.struct('LASTINPUTINFO', { cbSize: 'uint32_t', dwTime: 'uint32_t' });
  // GetGUIThreadInfo：拿前台 UI 线程的「焦点窗口 / 光标（caret）矩形」，stage_locate 的兜底定位用。
  const GUITHREADINFO = koffi.struct('GUITHREADINFO', {
    cbSize: 'uint32_t',
    flags: 'uint32_t',
    hwndActive: 'void *',
    hwndFocus: 'void *',
    hwndCapture: 'void *',
    hwndMenuOwner: 'void *',
    hwndMoveSize: 'void *',
    hwndCaret: 'void *',
    rcCaret: RECT,
  });

  const EnumWindowsProc = koffi.proto('bool __stdcall EnumWindowsProc(HWND hwnd, intptr_t lParam)');
  const MonitorEnumProc = koffi.proto(
    'bool __stdcall MonitorEnumProc(void *monitor, void *hdc, RECT *rect, intptr_t lParam)',
  );
  // GDI 截屏用的 32 位 DIB 描述（BITMAPINFO 只有 header，无调色板）。
  const BITMAPINFOHEADER = koffi.struct('BITMAPINFOHEADER', {
    biSize: 'uint32_t',
    biWidth: 'long',
    biHeight: 'long',
    biPlanes: 'uint16_t',
    biBitCount: 'uint16_t',
    biCompression: 'uint32_t',
    biSizeImage: 'uint32_t',
    biXPelsPerMeter: 'long',
    biYPelsPerMeter: 'long',
    biClrUsed: 'uint32_t',
    biClrImportant: 'uint32_t',
  });
  const BITMAPINFO = koffi.struct('BITMAPINFO', { bmiHeader: BITMAPINFOHEADER });

  return {
    koffi,
    RECT,
    MONITORINFO,
    LASTINPUTINFO,
    GUITHREADINFO,
    EnumWindows: user32.func('bool __stdcall EnumWindows(EnumWindowsProc *cb, intptr_t lParam)'),
    EnumDisplayMonitors: user32.func(
      'bool __stdcall EnumDisplayMonitors(void *hdc, RECT *clip, MonitorEnumProc *cb, intptr_t lParam)',
    ),
    GetMonitorInfoW: user32.func('bool __stdcall GetMonitorInfoW(void *monitor, _Inout_ MONITORINFO *info)'),
    IsWindowVisible: user32.func('bool __stdcall IsWindowVisible(HWND hwnd)'),
    IsIconic: user32.func('bool __stdcall IsIconic(HWND hwnd)'),
    GetWindowTextW: user32.func('int __stdcall GetWindowTextW(HWND hwnd, _Out_ uint16_t *buf, int max)'),
    GetClassNameW: user32.func('int __stdcall GetClassNameW(HWND hwnd, _Out_ uint16_t *buf, int max)'),
    GetWindowRect: user32.func('bool __stdcall GetWindowRect(HWND hwnd, _Out_ RECT *rect)'),
    GetWindowLongPtrW: user32.func('intptr_t __stdcall GetWindowLongPtrW(HWND hwnd, int index)'),
    GetForegroundWindow: user32.func('HWND __stdcall GetForegroundWindow()'),
    GetWindowThreadProcessId: user32.func(
      'uint32_t __stdcall GetWindowThreadProcessId(HWND hwnd, _Out_ uint32_t *pid)',
    ),
    SystemParametersInfoW: user32.func(
      'bool __stdcall SystemParametersInfoW(uint32_t action, uint32_t param, _Inout_ RECT *rect, uint32_t winIni)',
    ),
    OpenProcess: kernel32.func('void * __stdcall OpenProcess(uint32_t access, bool inherit, uint32_t pid)'),
    CloseHandle: kernel32.func('bool __stdcall CloseHandle(void *handle)'),
    QueryFullProcessImageNameW: kernel32.func(
      'bool __stdcall QueryFullProcessImageNameW(void *proc, uint32_t flags, _Out_ uint16_t *buf, _Inout_ uint32_t *size)',
    ),
    GetLastInputInfo: user32.func('bool __stdcall GetLastInputInfo(_Inout_ LASTINPUTINFO *info)'),
    GetGUIThreadInfo: user32.func(
      'bool __stdcall GetGUIThreadInfo(uint32_t tid, _Inout_ GUITHREADINFO *info)',
    ),
    GetTickCount: kernel32.func('uint32_t __stdcall GetTickCount()'),
    GetAsyncKeyState: user32.func('short __stdcall GetAsyncKeyState(int vKey)'),
    GetDpiForSystem: user32.func('uint32_t __stdcall GetDpiForSystem()'),
    DwmGetWindowAttributeInt: dwmapi.func(
      'long __stdcall DwmGetWindowAttribute(HWND hwnd, uint32_t attr, _Out_ int *value, uint32_t size)',
    ),
    DwmGetWindowAttributeRect: dwmapi.func(
      'long __stdcall DwmGetWindowAttribute(HWND hwnd, uint32_t attr, _Out_ RECT *value, uint32_t size)',
    ),
    /* ---- GDI 截屏（stage_locate 用；不做任何写操作，只读屏幕） ---- */
    BITMAPINFOHEADER,
    BITMAPINFO,
    GetDC: user32.func('HANDLE __stdcall GetDC(HWND hwnd)'),
    ReleaseDC: user32.func('int __stdcall ReleaseDC(HWND hwnd, HANDLE dc)'),
    GetSystemMetrics: user32.func('int __stdcall GetSystemMetrics(int index)'),
    CreateCompatibleDC: gdi32.func('HANDLE __stdcall CreateCompatibleDC(HANDLE dc)'),
    CreateCompatibleBitmap: gdi32.func('HANDLE __stdcall CreateCompatibleBitmap(HANDLE dc, int w, int h)'),
    SelectObject: gdi32.func('HANDLE __stdcall SelectObject(HANDLE dc, HANDLE obj)'),
    DeleteObject: gdi32.func('bool __stdcall DeleteObject(HANDLE obj)'),
    DeleteDC: gdi32.func('bool __stdcall DeleteDC(HANDLE dc)'),
    BitBlt: gdi32.func(
      'bool __stdcall BitBlt(HANDLE dst, int x, int y, int w, int h, HANDLE src, int sx, int sy, uint32_t rop)',
    ),
    GetDIBits: gdi32.func(
      'int __stdcall GetDIBits(HANDLE dc, HANDLE bmp, uint32_t start, uint32_t lines, _Out_ uint8_t *bits, _Inout_ BITMAPINFO *info, uint32_t usage)',
    ),
  };
}

/* --------------------------------------------------------------- 小工具 */

const emptyRect = () => ({ left: 0, top: 0, right: 0, bottom: 0 });
const rectOut = (r) => ({
  x: r.left,
  y: r.top,
  width: Math.max(0, r.right - r.left),
  height: Math.max(0, r.bottom - r.top),
});

function readUnicode(fn, hwnd, size = 1024) {
  const buf = new Uint16Array(size);
  const n = fn(hwnd, buf, size);
  if (!n || n <= 0) return '';
  return String.fromCharCode(...buf.subarray(0, Math.min(n, size)));
}

/** 窗口的可见外框（去掉 Windows 加在四周的隐形缩放边框）。 */
export function frameRect(hwnd) {
  const a = use();
  const r = emptyRect();
  if (a.DwmGetWindowAttributeRect(hwnd, DWMWA_EXTENDED_FRAME_BOUNDS, r, a.koffi.sizeof(a.RECT)) !== 0) {
    a.GetWindowRect(hwnd, r);
  }
  return rectOut(r);
}

/** 主显示器的工作区（任务栏之外的部分）。 */
export function workArea() {
  const a = use();
  const r = emptyRect();
  a.SystemParametersInfoW(SPI_GETWORKAREA, 0, r, 0);
  return rectOut(r);
}

/** 本进程看到的系统 DPI（100% 显示为 96）。 */
export function systemDpi() {
  const a = use();
  try {
    return Number(a.GetDpiForSystem()) || 96;
  } catch {
    return 96;
  }
}

let displaysCache = { at: 0, value: [] };

/** 所有显示器与各自工作区；结果缓存 3 秒。 */
export function displayWorkAreas() {
  const a = use();
  const now = Date.now();
  if (displaysCache.value.length && now - displaysCache.at < 3000) return displaysCache.value;
  const out = [];
  a.EnumDisplayMonitors(
    null,
    null,
    (monitor) => {
      const info = {
        cbSize: a.koffi.sizeof(a.MONITORINFO),
        rcMonitor: emptyRect(),
        rcWork: emptyRect(),
        dwFlags: 0,
      };
      if (!a.GetMonitorInfoW(monitor, info)) return true;
      const m = info.rcMonitor;
      const w = info.rcWork;
      out.push({
        id: a.koffi.address(monitor).toString(16),
        x: m.left,
        y: m.top,
        width: Math.max(0, m.right - m.left),
        height: Math.max(0, m.bottom - m.top),
        work: rectOut(w),
        primary: (info.dwFlags & 1) !== 0,
      });
      return true;
    },
    0,
  );
  if (!out.length) {
    const wa = workArea();
    out.push({ id: 'primary', ...wa, work: wa, primary: true });
  }
  displaysCache = { at: now, value: out };
  return out;
}

/** 点所在的显示器；不在任何显示器里时取最近的。 */
export function displayAt(x, y) {
  const all = displayWorkAreas();
  const inside = all.find((d) => x >= d.x && x < d.x + d.width && y >= d.y && y < d.y + d.height);
  if (inside) return inside;
  let best = null;
  for (const d of all) {
    const dx = x < d.x ? d.x - x : x > d.x + d.width ? x - (d.x + d.width) : 0;
    const dy = y < d.y ? d.y - y : y > d.y + d.height ? y - (d.y + d.height) : 0;
    const dist = dx * dx + dy * dy;
    if (!best || dist < best.dist) best = { ...d, dist };
  }
  return best;
}

/* ------------------------------------------------------- 进程名（带缓存） */

const exeCache = new Map();

function processExe(pid) {
  if (!pid) return { name: '', path: '' };
  const hit = exeCache.get(pid);
  if (hit && Date.now() - hit.at < 60_000) return hit;
  const a = use();
  let name = '';
  let path = '';
  const handle = a.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
  if (handle) {
    try {
      const buf = new Uint16Array(2048);
      const size = [buf.length];
      if (a.QueryFullProcessImageNameW(handle, 0, buf, size) && size[0] > 0) {
        path = String.fromCharCode(...buf.subarray(0, Math.min(size[0], buf.length)));
        const base = path.split(/[\\/]/).pop() || '';
        name = base.replace(/\.exe$/i, '');
      }
    } finally {
      a.CloseHandle(handle);
    }
  }
  const value = { name: name.toLowerCase(), path, at: Date.now() };
  exeCache.set(pid, value);
  if (exeCache.size > 64) exeCache.delete(exeCache.keys().next().value);
  return value;
}

/* ----------------------------------------------------------- 前台窗口 */

/**
 * 前台窗口快照；没有前台窗口时返回 null。
 * rect 是可见外框；style/exStyle 是窗口样式位；monitor 是窗口中心所在的显示器。
 */
export function foreground() {
  const a = use();
  const hwnd = a.GetForegroundWindow();
  if (!hwnd) return null;
  const addr = Number(a.koffi.address(hwnd));
  if (!addr) return null;
  const pidBuf = [0];
  a.GetWindowThreadProcessId(hwnd, pidBuf);
  const pid = pidBuf[0];
  const style = Number(a.GetWindowLongPtrW(hwnd, GWL_STYLE));
  const exStyle = Number(a.GetWindowLongPtrW(hwnd, GWL_EXSTYLE));
  const rect = frameRect(hwnd);
  const exe = processExe(pid);
  const monitor = displayAt(rect.x + rect.width / 2, rect.y + rect.height / 2);
  return {
    hwnd: addr,
    hwndHex: addr.toString(16),
    pid,
    title: readUnicode(a.GetWindowTextW, hwnd, 1024),
    className: readUnicode(a.GetClassNameW, hwnd, 256),
    exe: exe.name,
    exePath: exe.path,
    rect,
    style,
    exStyle,
    visible: !!a.IsWindowVisible(hwnd),
    iconic: !!a.IsIconic(hwnd),
    maximized: (style & WS_MAXIMIZE) !== 0,
    hasCaption: (style & WS_CAPTION) !== 0,
    monitor,
  };
}

/* --------------------------------------------------- 前台线程光标（caret） */

/**
 * 前台窗口所在 UI 线程的文本光标（caret）矩形（屏幕坐标，虚拟化后）。
 * UIA 不可用或焦点控件拿不到矩形时，stage_locate 用它兜底定位输入框。
 * 返回 { ok, rect:{x,y,width,height}, focusHwndHex } 或 { ok:false, reason }。
 */
export function caretRect(hwnd) {
  const a = use();
  let target = hwnd;
  if (!target) {
    target = a.GetForegroundWindow();
    if (!target) return { ok: false, reason: 'no-foreground' };
  }
  const pidBuf = [0];
  const tid = Number(a.GetWindowThreadProcessId(target, pidBuf)) >>> 0;
  if (!tid) return { ok: false, reason: 'no-thread' };
  const info = {
    cbSize: a.koffi.sizeof(a.GUITHREADINFO),
    flags: 0,
    hwndActive: null,
    hwndFocus: null,
    hwndCapture: null,
    hwndMenuOwner: null,
    hwndMoveSize: null,
    hwndCaret: null,
    rcCaret: emptyRect(),
  };
  if (!a.GetGUIThreadInfo(tid, info)) return { ok: false, reason: 'gui-thread-info-failed' };
  const r = rectOut(info.rcCaret);
  if (r.width <= 0 || r.height <= 0) return { ok: false, reason: 'no-caret' };
  const focusAddr = info.hwndFocus ? Number(a.koffi.address(info.hwndFocus)) : 0;
  return { ok: true, rect: r, focusHwndHex: focusAddr ? focusAddr.toString(16) : '' };
}

/* --------------------------------------------------------------- 截屏（GDI） */

const SRCCOPY = 0x00cc0020;
const CAPTUREBLT = 0x40000000;
const BI_RGB = 0;
const DIB_RGB_COLORS = 0;

/**
 * 截取主屏，返回 { width, height, bgra }（BGRA 顺序、自顶向下）。
 * 纯只读 GDI：不注入、不抢焦点、不改任何窗口；供 stage_locate 使用。
 * 注意：本进程是 DPI-unaware，Windows 会做虚拟化；100% 缩放下结果等于屏幕物理像素。
 */
export function captureScreen() {
  const a = use();
  const width = Number(a.GetSystemMetrics(0)) || 0; // SM_CXSCREEN
  const height = Number(a.GetSystemMetrics(1)) || 0; // SM_CYSCREEN
  if (width <= 0 || height <= 0) throw new Error(`captureScreen: bad screen size ${width}x${height}`);
  const screen = a.GetDC(null);
  if (!screen) throw new Error('captureScreen: GetDC failed');
  let mem = null;
  let bmp = null;
  let old = null;
  try {
    mem = a.CreateCompatibleDC(screen);
    bmp = a.CreateCompatibleBitmap(screen, width, height);
    if (!mem || !bmp) throw new Error('captureScreen: CreateCompatible* failed');
    old = a.SelectObject(mem, bmp);
    if (!a.BitBlt(mem, 0, 0, width, height, screen, 0, 0, (SRCCOPY | CAPTUREBLT) >>> 0)) {
      throw new Error('captureScreen: BitBlt failed');
    }
    const info = {
      bmiHeader: {
        biSize: a.koffi.sizeof(a.BITMAPINFOHEADER),
        biWidth: width,
        biHeight: -height, // 负数 = 自顶向下的行序（对应 PNG 行序）
        biPlanes: 1,
        biBitCount: 32,
        biCompression: BI_RGB,
        biSizeImage: width * height * 4,
        biXPelsPerMeter: 0,
        biYPelsPerMeter: 0,
        biClrUsed: 0,
        biClrImportant: 0,
      },
    };
    const bgra = new Uint8Array(width * height * 4);
    const lines = a.GetDIBits(mem, bmp, 0, height, bgra, info, DIB_RGB_COLORS);
    if (lines !== height) throw new Error(`captureScreen: GetDIBits ${lines}/${height}`);
    return { width, height, bgra };
  } finally {
    try {
      if (old) a.SelectObject(mem, old);
    } catch {
      /* ignore */
    }
    try {
      if (bmp) a.DeleteObject(bmp);
    } catch {
      /* ignore */
    }
    try {
      if (mem) a.DeleteDC(mem);
    } catch {
      /* ignore */
    }
    try {
      a.ReleaseDC(null, screen);
    } catch {
      /* ignore */
    }
  }
}

/* --------------------------------------------------- 可见的顶层窗口列表 */

/**
 * 可见、有标题、未最小化、未 cloaked 的顶层窗口，按 z 序返回（最上层在前）。
 * 只给探针和排错用，状态机不依赖窗口枚举。
 */
export function windows() {
  const a = use();
  const out = [];
  const limit = 60;
  a.EnumWindows((hwnd) => {
    if (out.length >= limit) return false;
    if (!a.IsWindowVisible(hwnd)) return true;
    if (a.IsIconic(hwnd)) return true;
    if (Number(a.GetWindowLongPtrW(hwnd, GWL_EXSTYLE)) & WS_EX_TOOLWINDOW) return true;
    const cloaked = [0];
    if (a.DwmGetWindowAttributeInt(hwnd, DWMWA_CLOAKED, cloaked, 4) === 0 && cloaked[0] !== 0) return true;
    const title = readUnicode(a.GetWindowTextW, hwnd, 512);
    if (!title) return true;
    const rect = frameRect(hwnd);
    if (rect.width < 40 || rect.height < 40) return true;
    const pidBuf = [0];
    a.GetWindowThreadProcessId(hwnd, pidBuf);
    const pid = pidBuf[0];
    const addr = Number(a.koffi.address(hwnd));
    out.push({
      hwnd: addr,
      hwndHex: addr.toString(16),
      pid,
      title,
      className: readUnicode(a.GetClassNameW, hwnd, 256),
      exe: processExe(pid).name,
      ...rect,
    });
    return true;
  }, 0);
  return out;
}

/* ---------------------------------------------------------- 输入空闲/按键 */

/** 距离上一次任何键鼠输入的毫秒数。 */
export function lastInputIdleMs() {
  const a = use();
  const info = { cbSize: a.koffi.sizeof(a.LASTINPUTINFO), dwTime: 0 };
  if (!a.GetLastInputInfo(info)) return 0;
  const diff = (a.GetTickCount() >>> 0) - (info.dwTime >>> 0);
  return Math.max(0, diff >>> 0);
}

/**
 * 当前按下的、我们关心的虚拟键（只看高位的 0x8000）。
 * 轮询 80ms 一次，由调用方比较前后两帧得到「新按下」。
 */
export function pressedKeys() {
  const a = use();
  const down = [];
  for (const vk of POLL_VKS) {
    const state = a.GetAsyncKeyState(vk);
    if ((state & 0x8000) !== 0) down.push(vk);
  }
  return down;
}

/** 单键查询，探针用。 */
export function keyDown(vk) {
  const a = use();
  return (a.GetAsyncKeyState(vk) & 0x8000) !== 0;
}

/** 给探针用：绑定的原始 koffi 对象。 */
export function raw() {
  return api;
}
