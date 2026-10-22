/**
 * 打字会话状态机。只在「焦点在可编辑控件 + 连续按键脉冲」成立一段时间后推一条
 * stage.typing；停止打字（默认 2.5s 无按键）或焦点离开后推一条 stage.typing.ended。
 * 绝不按每键推事件，也绝不读取输入内容。
 */

export class TypingMachine {
  #cfg;
  #emit;
  #log;
  #clock;
  #session = null;
  #startEmitAt = null;
  #lastSuppressed = false;

  constructor({ config, emit, log = null, clock = () => Date.now() } = {}) {
    this.#cfg = normalizeTypingConfig(config);
    this.#emit = typeof emit === 'function' ? emit : () => {};
    this.#log = log;
    this.#clock = typeof clock === 'function' ? clock : () => Date.now();
  }

  get enabled() {
    return this.#cfg.enabled;
  }

  /** 每 ~400ms 由 index.js 调一次。 */
  update({ foreground, uia, keys } = {}) {
    const now = this.#clock();
    const cfg = this.#cfg;
    if (!cfg.enabled) {
      if (this.#session) this.#finish(now, 'disabled');
      return;
    }
    const focus = this.#resolveFocus(foreground, uia, now);
    if (this.#session) this.#advance(now, foreground, focus, keys);
    else this.#maybeBegin(now, foreground, focus, keys);
  }

  /** 探针用的打字状态。 */
  snapshot(keys, now = this.#clock()) {
    const lastKeyAt = keys && typeof keys.lastAt === 'function' ? keys.lastAt() : 0;
    const session = this.#session;
    return {
      active: !!session,
      app: session ? session.app : '',
      element: session ? session.elementName : '',
      source: session ? session.source : '',
      rect: session ? { ...session.rect } : null,
      lastKeyAgoMs: lastKeyAt ? Math.max(0, now - lastKeyAt) : -1,
    };
  }

  reset() {
    this.#session = null;
  }

  /** 热更新配置（WebUI 改打字冷却等，不用重启世界）。 */
  setConfig(config) {
    this.#cfg = normalizeTypingConfig(config);
  }

  /** 判定当前焦点是否算「输入框」。返回 {editable, rect, app, elementName, source, key} 或 null。 */
  #resolveFocus(foreground, uia, now) {
    const cfg = this.#cfg;
    if (!foreground || !foreground.ok || foreground.ownWindow) return null;
    const fgRect = foreground.rect;

    if (uia && uia.ok && uia.editable && uia.rect && now - Number(uia.at || 0) <= cfg.freshSampleMs) {
      const r = uia.rect;
      if (r.width >= 8 && r.height >= 8 && overlaps(r, fgRect) >= 0.4) {
        return {
          editable: true,
          rect: { x: r.x, y: r.y, width: r.width, height: r.height },
          app: appLabel(foreground),
          elementName: String(uia.name || '').slice(0, 40),
          source: 'uia',
          key: `${foreground.pid}:${fgRect.x},${fgRect.y},${fgRect.width},${fgRect.height}`,
        };
      }
    }

    if (cfg.fallback && fgRect && fgRect.width >= 240 && fgRect.height >= 160) {
      return {
        editable: true,
        rect: fallbackInputRect(fgRect, cfg),
        app: appLabel(foreground),
        elementName: '',
        source: 'heuristic',
        key: `${foreground.pid}:${fgRect.x},${fgRect.y},${fgRect.width},${fgRect.height}`,
      };
    }
    return null;
  }

  #maybeBegin(now, foreground, focus, keys) {
    const cfg = this.#cfg;
    if (!focus || !keys) return;
    const lastKeyAt = keys.lastAt();
    if (!lastKeyAt || now - lastKeyAt > cfg.sessionWindowMs) return;
    const recent = keys.countSince(now - cfg.sessionWindowMs);
    if (recent < cfg.keyTransitions) return;
    this.#session = {
      startedAt: now,
      startEmitAt: 0,
      startEmitted: false,
      rect: focus.rect,
      app: focus.app,
      elementName: focus.elementName,
      source: focus.source,
      fgHwnd: foreground ? foreground.hwnd : 0,
      lastKeyAt,
      lastFocusAt: now,
      lastValidAt: now,
      windowKey: focus.key,
    };
    this.#log?.info?.(`stage: typing session begin (${focus.source}, ${focus.app || 'unknown'})`);
  }

  #advance(now, foreground, focus, keys) {
    const cfg = this.#cfg;
    const session = this.#session;
    const lastKeyAt = keys && typeof keys.lastAt === 'function' ? keys.lastAt() : session.lastKeyAt;
    if (lastKeyAt > session.lastKeyAt) session.lastKeyAt = lastKeyAt;

    const fgOk = !!foreground && foreground.ok === true && foreground.ownWindow !== true;
    const sameApp = focus ? focus.key === session.windowKey || focus.app === session.app : false;
    const sameWindow = fgOk && (focus ? true : foreground.hwnd === session.fgHwnd);
    if (fgOk && sameApp && sameWindow) {
      session.lastFocusAt = now;
      session.lastValidAt = now;
      session.rect = focus.rect;
      session.elementName = focus.elementName || session.elementName;
      session.source = focus.source || session.source;
    }

    const idleMs = now - session.lastKeyAt;
    const focusLostMs = now - session.lastFocusAt;

    if (idleMs >= cfg.endIdleMs) return this.#finish(now, `idle=${idleMs}ms`);
    if (focusLostMs >= cfg.focusGraceMs) return this.#finish(now, 'focus-left');
    if (!fgOk) return this.#finish(now, 'window-changed');

    // 达到最小时长后尝试推 start；被冷却压住时不要标记为已推，冷却过去后可以补推。
    if (!session.startEmitted && now - session.startedAt >= cfg.minSessionMs && idleMs < cfg.endIdleMs) {
      const cooldownOk = this.#startEmitAt === null || now - this.#startEmitAt >= cfg.cooldownSec * 1000;
      if (cooldownOk) {
        session.startEmitted = true;
        session.startEmitAt = now;
        this.#startEmitAt = now;
        this.#lastSuppressed = false;
        this.#emit({ kind: 'start', at: now, session: snapshotSession(session) });
      } else if (!this.#lastSuppressed) {
        this.#lastSuppressed = true;
        this.#log?.info?.('stage: typing start suppressed by cooldown');
      }
    }
  }

  #finish(now, reason) {
    const session = this.#session;
    this.#session = null;
    if (!session) return;
    const lasted = now - session.startedAt;
    this.#log?.info?.(`stage: typing session end (${reason}, ${lasted}ms)`);
    if (session.startEmitted && now - session.startEmitAt >= this.#cfg.emitEndedMinMs) {
      this.#emit({ kind: 'end', at: now, reason, session: snapshotSession(session) });
    }
  }
}

function snapshotSession(session) {
  return {
    rect: { ...session.rect },
    app: session.app,
    elementName: session.elementName,
    source: session.source,
    startedAt: session.startedAt,
    lastKeyAt: session.lastKeyAt,
  };
}

/** 输入框落点：底边中点（她坐在输入框下边缘）。 */
export function inputPoint(rect) {
  return { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height) };
}

/** UIA 不可用时的保守猜测：窗口下半部、水平居中的一条输入框区域。stage_locate 也复用它。 */
export function fallbackInputRect(rect, cfg) {
  const side = cfg.fallbackSideFrac;
  const top = cfg.fallbackTopFrac;
  const height = cfg.fallbackHeightFrac;
  return {
    x: Math.round(rect.x + rect.width * side),
    y: Math.round(rect.y + rect.height * top),
    width: Math.max(40, Math.round(rect.width * (1 - side * 2))),
    height: Math.max(16, Math.round(rect.height * height)),
  };
}

function overlaps(inner, outer) {
  if (!inner || !outer || inner.width <= 0 || inner.height <= 0) return 0;
  const x0 = Math.max(inner.x, outer.x);
  const y0 = Math.max(inner.y, outer.y);
  const x1 = Math.min(inner.x + inner.width, outer.x + outer.width);
  const y1 = Math.min(inner.y + inner.height, outer.y + outer.height);
  if (x1 <= x0 || y1 <= y0) return 0;
  const area = inner.width * inner.height;
  return ((x1 - x0) * (y1 - y0)) / area;
}

function appLabel(foreground) {
  const title = String(foreground.title || '').trim();
  if (title) return title.slice(0, 60);
  return String(foreground.exeName || '').slice(0, 40);
}

function clampNum(value, fallback, min, max) {
  const n = Number(value);
  const v = Number.isFinite(n) ? n : fallback;
  return Math.min(max, Math.max(min, v));
}

export function normalizeTypingConfig(typing) {
  const t = typing && typeof typing === 'object' ? typing : {};
  return {
    enabled: t.enabled !== false,
    keyTransitions: Math.round(clampNum(t.keyTransitions, 2, 1, 20)),
    minSessionMs: clampNum(t.minSessionMs, 1500, 300, 15000),
    endIdleMs: clampNum(t.endIdleMs, 2500, 1000, 20000),
    focusGraceMs: clampNum(t.focusGraceMs, 800, 200, 5000),
    sessionWindowMs: clampNum(t.sessionWindowMs, 4000, 1000, 15000),
    freshSampleMs: clampNum(t.freshSampleMs, 2000, 300, 5000),
    cooldownSec: clampNum(t.cooldownSec, 45, 5, 600),
    emitEndedMinMs: clampNum(t.emitEndedMinMs, 2000, 0, 60000),
    fallback: t.fallback !== false,
    fallbackSideFrac: clampNum(t.fallbackSideFrac, 0.22, 0, 0.45),
    fallbackTopFrac: clampNum(t.fallbackTopFrac, 0.62, 0.3, 0.9),
    fallbackHeightFrac: clampNum(t.fallbackHeightFrac, 0.12, 0.04, 0.4),
  };
}
