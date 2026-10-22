/**
 * stage_locate 的定位逻辑：截图 + 找输入框 / 视频画面，换算成可直接照抄的
 * `pet_move_to` 落点（分数坐标 x = 横向比例，y = 落座高度比例）。
 *
 * 只读：读前台窗口、UIA 焦点矩形、caret 矩形；不读输入内容、不抢焦点、不做任何键鼠注入。
 *
 * 定位优先级（输入框）：
 *   1. UIA 焦点元素（最准；限输入框类控件，采样太旧则跳过）
 *   2. GetGUIThreadInfo 的 caret：用光标所在行 + 窗口水平居中推断输入行
 *   3. typing.fallback 启发式：窗口下半部、水平居中（明确标注「估计值」）
 * 视频画面复用 video.js 的浏览器窗口启发式。
 */
import { fallbackInputRect } from './typing.js';
import { detectVideo } from './video.js';
import { clamp01 } from './util.js';

const INPUT_TYPES = new Set(['Edit', 'ComboBox', 'Document', 'Text', 'RichEdit']);

/** 屏幕像素 → 舞台横向比例 0..1（与 index.js 的 fracOfX 保持同一公式）。 */
function fracX(px, stage) {
  return clamp01((Number(px) - Number(stage?.originX ?? 0)) / Math.max(1, Number(stage?.width) || 1920));
}

/** 屏幕像素 → 舞台纵向比例 0..1。 */
function fracY(px, stage) {
  return clamp01((Number(px) - Number(stage?.originY ?? 0)) / Math.max(1, Number(stage?.height) || 1080));
}

/** 两位小数字符串（与事件文本同一格式）。 */
function f2(value) {
  return (Math.round((Number(value) || 0) * 100) / 100).toFixed(2);
}

const normRect = (rect) => {
  if (!rect) return null;
  const x = Number(rect.x);
  const y = Number(rect.y);
  const w = Number(rect.w ?? rect.width);
  const h = Number(rect.h ?? rect.height);
  if (![x, y, w, h].every((n) => Number.isFinite(n))) return null;
  if (w <= 0 || h <= 0) return null;
  return { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) };
};

/**
 * 找输入框。
 * @returns {{ok:boolean, kind:'input', rect:{x,y,w,h}|null, source:string, element?:string, notes:string[]}}
 */
export function locateInput({ win32 = null, uia = null, foreground = null, config = {} } = {}) {
  const notes = [];
  const typingCfg = config?.typing && typeof config.typing === 'object' ? config.typing : {};
  const freshMs = Number.isFinite(Number(typingCfg.freshSampleMs)) ? Number(typingCfg.freshSampleMs) : 2000;

  // 1) UIA 焦点元素：最准
  const sample = uia && typeof uia.last === 'function' ? uia.last() : null;
  if (sample && sample.ok === true && sample.rect) {
    const rect = normRect(sample.rect);
    const ageMs = Date.now() - Number(sample.at || 0);
    const editable =
      sample.editable === true ||
      (sample.value === true && sample.readonly !== true) ||
      INPUT_TYPES.has(String(sample.type || ''));
    if (rect && rect.w >= 8 && rect.h >= 8 && editable && ageMs <= freshMs) {
      return {
        ok: true,
        kind: 'input',
        rect,
        source: 'uia',
        element: String(sample.name || '').slice(0, 40),
        notes,
      };
    }
    if (rect && editable && ageMs > freshMs) notes.push('UIA 采样已过期');
    if (rect && !editable) notes.push(`焦点控件不可编辑（${String(sample.type || '?')}）`);
  } else {
    notes.push('UIA 不可用或还没采样');
  }

  // 2) caret：光标所在行 + 窗口水平居中推断输入行
  if (win32 && typeof win32.caretRect === 'function') {
    try {
      const caret = win32.caretRect(foreground?.hwnd || 0);
      if (caret?.ok) {
        const fgRect = foreground?.rect;
        const line = normRect(caret.rect);
        const h = Math.max(18, line ? line.h : 18);
        const fgX = fgRect ? Number(fgRect.x) : 0;
        const fgW = fgRect ? Number(fgRect.width) : 960;
        const side = Math.max(0.05, Math.min(0.45, Number(typingCfg.fallbackSideFrac ?? 0.22) || 0.22));
        const rect = normRect({
          x: fgX + fgW * side,
          y: line ? line.y : Number(fgRect?.y ?? 0) + Number(fgRect?.height ?? 0) * 0.8,
          w: Math.max(120, fgW * (1 - side * 2)),
          h,
        });
        if (rect) {
          notes.push('按光标行定位（估计值）');
          return { ok: true, kind: 'input', rect, source: 'caret', element: '', notes };
        }
      } else if (caret?.reason) {
        notes.push(`光标定位不可用：${caret.reason}`);
      }
    } catch (error) {
      notes.push(`光标定位失败：${String(error?.message ?? error)}`);
    }
  }

  // 3) 启发式：窗口下半部一块输入区
  const fgRect = normRect(foreground?.rect);
  if (typingCfg.fallback !== false && fgRect && fgRect.w >= 240 && fgRect.h >= 160) {
    const cfg = {
      fallbackSideFrac: Number(typingCfg.fallbackSideFrac) || 0.22,
      fallbackTopFrac: Number(typingCfg.fallbackTopFrac) || 0.62,
      fallbackHeightFrac: Number(typingCfg.fallbackHeightFrac) || 0.12,
    };
    const rect = normRect(fallbackInputRect(fgRect, cfg));
    if (rect) {
      notes.push('按窗口下半部猜测的输入框位置（估计值）');
      return { ok: true, kind: 'input', rect, source: 'heuristic', element: '', notes };
    }
  }

  return { ok: false, kind: 'input', rect: null, source: 'none', element: '', notes };
}

/**
 * 找视频画面（复用 video.js 的浏览器窗口启发式）。
 * @returns {{ok:boolean, kind:'video', rect:{x,y,w,h}|null, source:string, title?:string, fullscreen?:boolean, notes:string[]}}
 */
export function locateVideo({ foreground = null, config = {} } = {}) {
  const notes = [];
  if (!foreground || foreground.ok !== true) {
    notes.push('没有前台窗口');
    return { ok: false, kind: 'video', rect: null, source: 'none', notes };
  }
  if (foreground.iconic === true) {
    notes.push('前台窗口已最小化，无法定位视频');
    return { ok: false, kind: 'video', rect: null, source: 'none', notes };
  }
  let matched = null;
  try {
    matched = detectVideo(foreground, config);
  } catch (error) {
    notes.push(`视频识别失败：${String(error?.message ?? error)}`);
  }
  const rect = normRect(matched?.rect);
  if (!matched || !rect) {
    notes.push(`前台窗口不是支持的浏览器视频（${String(foreground.exeName || foreground.exe || '?')}）`);
    return { ok: false, kind: 'video', rect: null, source: 'none', notes };
  }
  if (matched.source === 'fullscreen') {
    notes.push('全屏视频：矩形是精确的');
  } else {
    notes.push('浏览器窗口里的 16:9 画面区域是推算的（估计值）');
  }
  return {
    ok: true,
    kind: 'video',
    rect,
    source: matched.source === 'fullscreen' ? 'video-fullscreen' : 'video-heuristic',
    title: String(matched.title || ''),
    fullscreen: !!matched.fullscreen,
    notes,
  };
}

/**
 * 把定位结果变成「模型可以直接照抄」的返回体（stage_locate 的 JSON）。
 * 输入框：x = 矩形横向中心比例，y = 输入框下边缘比例（她坐在输入框下沿）。
 * 视频：y = 视频下边缘比例，x = 视频底边左下角或右下角（取屏幕水平留白更多的一侧，
 * 相等选左）；`fractions` 里同时给出 cornerLeft / cornerRight 两个角，方便排查。
 */
export function buildLocateResult({ kind, located, stage, foreground = null, shot = null, notes = [] } = {}) {
  const rect = located?.rect ?? null;
  const allNotes = [...(located?.notes ?? []), ...(notes ?? [])];
  if (!located?.ok || !rect) {
    return {
      ok: false,
      kind: kind === 'video' ? 'video' : 'input',
      source: 'none',
      rect: null,
      fractions: null,
      suggestion: null,
      display: {
        w: Number(stage?.width) || 0,
        h: Number(stage?.height) || 0,
        originX: Number(stage?.originX) || 0,
        originY: Number(stage?.originY) || 0,
      },
      foreground: foreground
        ? { title: String(foreground.title || ''), exe: String(foreground.exeName || foreground.exe || ''), pid: foreground.pid }
        : null,
      shot: shot ?? null,
      notes: allNotes,
    };
  }

  const isVideo = kind === 'video';
  const target = isVideo ? 'watch' : 'type';
  let fx;
  let fy;
  let fractions;
  if (isVideo) {
    const ox = Number(stage?.originX) || 0;
    const W = Math.max(1, Number(stage?.width) || 1920);
    // 视频底边两个角：取屏幕水平留白更多的一侧（左边距 vs 右边距，相等选左）
    const leftGap = rect.x - ox;
    const rightGap = ox + W - (rect.x + rect.w);
    const useLeft = leftGap >= rightGap;
    const cornerX = useLeft ? rect.x : rect.x + rect.w;
    fx = fracX(cornerX, stage);
    fy = fracY(rect.y + rect.h, stage);
    fractions = {
      x: round2(fx),
      y: round2(fy),
      corner: useLeft ? 'left' : 'right',
      cornerLeft: { x: round2(fracX(rect.x, stage)), y: round2(fracY(rect.y + rect.h, stage)) },
      cornerRight: { x: round2(fracX(rect.x + rect.w, stage)), y: round2(fracY(rect.y + rect.h, stage)) },
    };
    allNotes.push(
      useLeft
        ? `坐视频左下角${leftGap === rightGap ? '（左右留白相同，默认左）' : ''}`
        : '坐视频右下角',
    );
  } else {
    fx = fracX(rect.x + rect.w / 2, stage);
    fy = fracY(rect.y + rect.h, stage);
    fractions = { x: round2(fx), y: round2(fy) };
  }
  return {
    ok: true,
    kind: isVideo ? 'video' : 'input',
    source: located.source,
    rect: { x: rect.x, y: rect.y, w: rect.w, h: rect.h },
    fractions,
    suggestion: `pet_move_to {to:"${target}", params:[${f2(fx)}, ${f2(fy)}]}`,
    element: located.element ?? '',
    title: located.title ?? '',
    fullscreen: located.fullscreen ?? false,
    display: {
      w: Number(stage?.width) || 0,
      h: Number(stage?.height) || 0,
      originX: Number(stage?.originX) || 0,
      originY: Number(stage?.originY) || 0,
    },
    foreground: foreground
      ? {
          title: String(foreground.title || ''),
          exe: String(foreground.exeName || foreground.exe || ''),
          pid: foreground.pid,
        }
      : null,
    shot: shot ?? null,
    notes: allNotes,
  };
}

function round2(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}
