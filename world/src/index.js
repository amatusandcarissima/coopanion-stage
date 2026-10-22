/**
 * cortico-world-stage —— 让鲸鱼娘 Coo 能「坐」到视频和输入框上的 World 扩展。
 *
 * 职责只有两件：
 *   1. 感知：前台窗口是不是在放视频、焦点是不是在输入框里（只读窗口标题/矩形，不读输入内容）。
 *   2. 通报（可选，默认关）：用 host.pushEvent 把「对用户在陪看 / 在打字」写成中文事件，让模型自己决定调用
 *      desktop-pet 世界的 pet_move_to（to="watch" / "type" / "floor"）走过去、坐上去。
 *
 * 世界本身不直接命令宠物，也不改任何系统设置；定时器里的一切异常都吞掉，避免拖垮 Core。
 */
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { KeyPulse } from './keyboard.js';
import { stageConfigGroup } from './configGroup.js';
import { buildLocateResult, locateInput, locateVideo } from './locate.js';
import { StageLog } from './logger.js';
import { startProbeServer } from './probe.js';
import { captureScreenshot, pruneShots, shotFileName } from './screenshot.js';
import { inputPoint, normalizeTypingConfig, TypingMachine } from './typing.js';
import { UiaWatcher } from './uia.js';
import { clamp01, mergeConfig, nowIso, round, shorten, truncate } from './util.js';
import { detectVideo } from './video.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_DIR = dirname(HERE);
const ENV_PROMPT_PATH = join(PACKAGE_DIR, 'ENV_PROMPT.md');

/**
 * 世界 id 定稿为 `stage`（Lead 与形象包侧已对齐；配置键为 worlds.stage.*）。
 * 注意：包名仍是 cortico-world-stage，两者不是一回事。
 */
const WORLD_ID = 'stage';

/* --------------------------------------------------------------- 默认配置 */

export const DEFAULT_CONFIG = {
  /** 由 Lead / 用户手动改成 true 才会挂载（Coopanion 的 world 配置）。 */
  enabled: false,
  /** 调试日志：<dataDir>/logs/stage.log，一行一条。 */
  debug: { log: true, console: false, sampleLogSec: 15 },
  /** 本地探针 HTTP（只读）；port=0 关闭。默认避开 7797/17788/19387/9223/3517。 */
  probe: { enabled: true, host: '127.0.0.1', port: 19388 },
  /** 与 WebUI 配置组（src/configGroup.js）一致的扁平键；都可在设置页里调，改完即生效。 */
  /** 同一视频重复通报的最短间隔（秒）。 */
  videoCooldownSec: 90,
  /** 两段打字会话之间至少间隔多久（秒）。 */
  typingCooldownSec: 45,
  /** 浏览器标题变化后重新通报的最短间隔（秒）。 */
  titleCooldownSec: 30,
  /** 本地探针端口（0 = 关闭；改端口需重启世界）。 */
  probePort: 19388,
  /** stage_locate 截图参数（只保存在本地 <dataDir>/logs/stage-shots/）。 */
  screenshot: { enabled: true, maxWidth: 1600, quality: 90, format: 'png', keep: 20 },
  /** 宠物舞台（透明覆盖窗口）的坐标覆盖；null = 用主显示器工作区。scale = 显示缩放（100% 为 1）。 */
  stage: { originX: null, originY: null, width: null, height: null, screenW: null, screenH: null, scale: 1 },
  /** 宠物窗口视觉状态（从 companion/config.json 的 desktop-pet 世界读，这里可强制覆盖）。 */
  pet: { hideWhenFullscreen: null },
  /** 采样与按键轮询间隔（毫秒）。Lead 建议 pollMs 默认 700–1000（省一点 CPU）。 */
  pollMs: 800,
  keyPollMs: 80,
  /** 两个独立开关：对「用户」在看视频/打字做反应（默认关）。她的「自己做动作」由环境提示词驱动，不依赖这两个开关。 */
  watchEnabled: false,
  typingEnabled: false,
  video: {
    enabled: true,
    browsers: ['msedge', 'chrome', 'firefox', 'brave', 'vivaldi', 'opera', 'thorium', 'zen'],
    titles: ['bilibili', '哔哩哔哩', 'youtube', '抖音', 'douyin', '腾讯视频', '爱奇艺', 'netflix'],
    excludeTitles: [],
    chromeTop: 88,
    chromeSide: 12,
    chromeBottom: 0,
    fullscreenCoverage: 0.9,
    /** 同一视频重复通报的最短间隔（秒）。 */
    cooldownSec: 90,
    /** 标题变了（换视频/浏览器标题抖动）时的最短间隔（秒）。 */
    titleCooldownSec: 15,
    /** 窗口不再匹配后多久算「结束」（毫秒）。 */
    endGraceMs: 10000,
    /** 视频矩形中心移动超过舞台这个比例才重新通报。 */
    rectMoveFrac: 0.05,
  },
  typing: {
    enabled: true,
    keyTransitions: 2,
    minSessionMs: 1500,
    endIdleMs: 2500,
    focusGraceMs: 800,
    sessionWindowMs: 4000,
    freshSampleMs: 2000,
    cooldownSec: 45,
    emitEndedMinMs: 2000,
    fallback: true,
    fallbackSideFrac: 0.22,
    fallbackTopFrac: 0.62,
    fallbackHeightFrac: 0.12,
  },
  /** 标题命中这些子串就不算（默认空：自身窗口靠进程名 Coopanion.exe + 标题 "Cortico" 判断，
   *  避免误伤标题里提到 Coopanion 的文档窗口）。 */
  excludeTitles: [],
  /** 单条事件正文上限。 */
  maxEventChars: 600,
};

/* ----------------------------------------------------------- 事件文本契约 */

const ZERO_STAGE = { originX: 0, originY: 0, width: 1920, height: 1080, scale: 1 };

/** 取第一个有限数字：扁平键优先，兼容旧的嵌套键。 */
function numOr(...values) {
  for (const value of values) {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return 0;
}

/** 宠物窗口在屏幕上的舞台区域（覆盖一个显示器的工作区）。 */
export function stageGeometry(win32, config) {
  const stageCfg = config?.stage && typeof config.stage === 'object' ? config.stage : {};
  let base = { x: 0, y: 0, width: 1920, height: 1080 };
  try {
    if (win32?.available?.()) {
      const wa = win32.workArea();
      if (wa && wa.width > 0 && wa.height > 0) base = wa;
    }
  } catch {
    /* 用默认值 */
  }
  // Lead 建议的 screenW/screenH 覆盖项：既能写在顶层，也能写在 stage 里。
  const topW = Number(config?.screenW) > 0 ? Number(config.screenW) : null;
  const topH = Number(config?.screenH) > 0 ? Number(config.screenH) : null;
  const pick = (value, fallback) => {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  };
  return {
    originX: Number.isFinite(Number(stageCfg.originX)) ? Number(stageCfg.originX) : base.x,
    originY: Number.isFinite(Number(stageCfg.originY)) ? Number(stageCfg.originY) : base.y,
    width: Math.max(1, pick(stageCfg.width ?? stageCfg.screenW ?? topW, base.width)),
    height: Math.max(1, pick(stageCfg.height ?? stageCfg.screenH ?? topH, base.height)),
    scale: pick(stageCfg.scale, 1) > 0 ? pick(stageCfg.scale, 1) : 1,
  };
}

/** 页面点 → 分数（fx,fy 都在 0..1，超出舞台时夹到边缘）。 */
export function toFractions(point, stage) {
  const s = stage || ZERO_STAGE;
  const fx = clamp01((Number(point.x) - s.originX) / s.width);
  const fy = clamp01((Number(point.y) - s.originY) / s.height);
  return { fx: round(fx, 3), fy: round(fy, 3) };
}

export function isOwnWindow(win, config) {
  if (!win) return true;
  const exe = String(win.exe ?? win.exeName ?? '').toLowerCase().replace(/\.exe$/, '');
  if (exe === 'coopanion') return true;
  const title = String(win.title ?? '').trim().toLowerCase();
  // 宠物自己的窗口标题就是 "Cortico"；不要用子串匹配，否则标题里出现 cortico 的文档窗口
  // 会被误当成自身窗口，把打字感知关掉。
  if (title === 'cortico') return true;
  const list = Array.isArray(config?.excludeTitles) ? config.excludeTitles : [];
  return list.some((needle) => {
    const n = String(needle ?? '').trim().toLowerCase();
    return n.length > 0 && title.includes(n);
  });
}

/* ---------------------------------------------------------------- 世界实现 */

export class StageWorld {
  #ctx;
  #config;
  #host = null;
  #started = false;
  #stopped = false;
  #win32 = null;
  #win32Error = null;
  #uia = null;
  #keys = null;
  #typing = null;
  #stageLog = null;
  #timers = [];
  #tickTimer = null;
  #keyTimer = null;
  #sampleTimer = null;
  #probe = null;
  #log = { info: () => {}, warn: () => {}, error: () => {} };
  #stage = { ...ZERO_STAGE };
  #lastForeground = null;
  #video = { active: false, found: false, announced: false, title: '', rect: null, lastMatchAt: 0, emitAt: 0, fullscreen: false, source: 'none' };
  #typingPoint = null;
  #typingRect = null;
  #leaveAt = 0;
  #hideWhenFullscreen = false;
  #hideOverride = null;
  #flagAt = 0;
  #recentEvents = [];
  #errorCounts = new Map();
  #lastSampleLogAt = 0;
  #timeZone = 'Asia/Shanghai';

  constructor(ctx = {}) {
    this.#ctx = ctx;
    this.#config = mergeConfig(DEFAULT_CONFIG, ctx.cfg ?? ctx.config ?? {});
    this.#timeZone = ctx.timezone || 'Asia/Shanghai';
    const pet = this.#config.pet ?? {};
    if (typeof pet.hideWhenFullscreen === 'boolean') this.#hideOverride = pet.hideWhenFullscreen;
    if (this.#hideOverride !== null) this.#hideWhenFullscreen = this.#hideOverride;
  }

  get id() {
    return this.#ctx.id || WORLD_ID;
  }

  /* ------------------------------------------------------------- 生命周期 */

  async start(host) {
    if (this.#started) return;
    this.#started = true;
    this.#stopped = false;
    this.#host = host ?? null;

    const cfg = this.#config;
    try {
      this.#stageLog = new StageLog({
        dataDir: this.#ctx.dataDir,
        enabled: cfg.debug?.log !== false,
        consoleLog: cfg.debug?.console ? (line) => console.log(line) : null,
      });
    } catch {
      this.#stageLog = null;
    }
    this.#log = {
      info: (message) => this.#safeLog('info', message),
      warn: (message) => this.#safeLog('warn', message),
      error: (message) => this.#safeLog('error', message),
    };

    this.#log.info(`stage start id=${this.id} dataDir=${this.#ctx.dataDir ?? '?'}`);
    this.#writeLog('start', {
      id: this.id,
      dataDir: this.#ctx.dataDir ?? null,
      config: cfg,
      stage: this.#stage,
    });

    try {
      this.#win32 = await import('./win32.js');
      this.#stage = stageGeometry(this.#win32, cfg);
      if (!this.#win32.available()) {
        this.#win32Error = this.#win32.loadFailure() || 'koffi unavailable';
        this.#log.warn(`stage: win32 unavailable: ${this.#win32Error}`);
        this.#win32 = null;
      }
    } catch (error) {
      this.#win32 = null;
      this.#win32Error = String(error?.message ?? error);
      this.#log.warn(`stage: win32 load failed: ${this.#win32Error}`);
    }

    await this.#readCompanionFlags();

    if (this.#win32) {
      try {
        this.#uia = new UiaWatcher({ scriptPath: join(HERE, 'uia-watch.ps1'), log: this.#log });
        this.#uia.start();
      } catch (error) {
        this.#uia = null;
        this.#log.warn(`stage: uia watcher failed: ${error?.message ?? error}`);
      }
      try {
        this.#keys = new KeyPulse({
          // win32.keyDown() 返回 boolean;KeyPulse 要的是 GetAsyncKeyState 的原始位图(bit 0x8000)。
          getAsyncKeyState: (vk) => (this.#win32.keyDown(vk) ? 0x8000 : 0),
          vks: this.#win32.POLL_VKS,
        });
      } catch (error) {
        this.#keys = null;
        this.#log.warn(`stage: key pulse failed: ${error?.message ?? error}`);
      }
      try {
        this.#typing = new TypingMachine({
          config: this.#typingConfig(),
          log: this.#log,
          emit: (transition) => this.#onTypingTransition(transition),
        });
      } catch (error) {
        this.#typing = null;
        this.#log.warn(`stage: typing machine failed: ${error?.message ?? error}`);
      }
    }

    const pollMs = Math.max(150, Number(cfg.pollMs) || 400);
    const keyPollMs = Math.max(40, Number(cfg.keyPollMs) || 80);
    if (this.#win32) {
      this.#tickTimer = setInterval(() => this.#safe('tick', () => this.#tick()), pollMs);
      this.#keyTimer = setInterval(() => {
        try {
          this.#keys?.tick();
        } catch (error) {
          this.#safeError('key-poll', error);
        }
      }, keyPollMs);
    }
    const sampleLogSec = Math.max(0, Number(cfg.debug?.sampleLogSec) || 0);
    if (sampleLogSec > 0) {
      this.#lastSampleLogAt = Date.now();
      this.#sampleTimer = setInterval(() => this.#safe('sample-log', () => this.#logSample()), sampleLogSec * 1000);
    }
    for (const timer of [this.#tickTimer, this.#keyTimer, this.#sampleTimer]) timer?.unref?.();
    this.#timers = [this.#tickTimer, this.#keyTimer, this.#sampleTimer].filter(Boolean);

    if (this.#probeOn()) {
      try {
        this.#probe = await startProbeServer({
          port: this.#probePort(),
          host: String(cfg.probe.host || '127.0.0.1'),
          snapshot: () => this.snapshot(),
          onEvent: (event) => {
            this.#pushEvent(event.type, event.text).catch(() => {});
          },
          log: this.#log,
        });
      } catch (error) {
        this.#log.warn(`stage: probe server failed: ${error?.message ?? error}`);
        this.#probe = null;
      }
    }

    // 注意：不主动推「已启用」事件，避免打扰；能力说明放在 ENV_PROMPT.md 里。
    this.#log.info(`stage ready (watch=${this.#watchOn() ? 'on' : 'off'}, typing=${this.#typingOn() ? 'on' : 'off'})`);
    this.#writeLog('ready', { watchEnabled: this.#watchOn(), typingEnabled: this.#typingOn(), hideWhenFullscreen: this.#hideWhenFullscreen });
  }

  async stop() {
    if (!this.#started || this.#stopped) return;
    this.#stopped = true;
    this.#started = false;
    for (const timer of this.#timers) clearInterval(timer);
    this.#timers = [];
    this.#tickTimer = this.#keyTimer = this.#sampleTimer = null;
    try {
      this.#typing?.reset();
    } catch {
      /* ignore */
    }
    try {
      this.#uia?.stop();
    } catch {
      /* ignore */
    }
    this.#uia = null;
    try {
      const probe = this.#probe;
      this.#probe = null;
      await probe?.close?.();
    } catch {
      /* ignore */
    }
    this.#writeLog('stop', { recentEvents: this.#recentEvents.slice(-5) });
    try {
      await this.#stageLog?.flush();
    } catch {
      /* ignore */
    }
    this.#log.info('stage stopped');
  }

  /* -------------------------------------------------------- 工具 / 环境说明 */

  tools() {
    const parameters = { type: 'object', properties: {}, additionalProperties: false };
    return [
      {
        name: 'stage_status',
        description:
          '查看桌面现在在干什么：前台窗口、输入框/视频区域和可用的落点。你想「走到某个位置再摆姿势」或要确认坐到哪儿时调用。',
        parameters,
        tags: ['read'],
        handler: async () => {
          try {
            return JSON.stringify(this.snapshot());
          } catch (error) {
            return `stage_status 失败：${String(error?.message ?? error)}`;
          }
        },
      },
      {
        name: 'stage_probe',
        description:
          '开发者探针：返回当前一次完整采样 JSON（前台窗口、显示器、视频矩形、输入框矩形、宠物是否因全屏隐藏）。用于不开 UI 验证感知。',
        parameters,
        tags: ['read'],
        handler: async () => {
          try {
            return JSON.stringify(this.snapshot());
          } catch (error) {
            return `stage_probe 失败：${String(error?.message ?? error)}`;
          }
        },
      },
      {
        name: 'stage_check',
        description:
          '检查「对用户做反应」的开关（watchEnabled/typingEnabled，默认关），以及宠物是否会因全屏（hideWhenFullscreen）被隐藏。她自己看视频/打字做动作由提示词驱动，没有开关。',
        parameters,
        tags: ['read'],
        handler: async () => {
          try {
            return JSON.stringify(this.#check());
          } catch (error) {
            return `stage_check 失败：${String(error?.message ?? error)}`;
          }
        },
      },
      {
        name: 'stage_locate',
        description:
          '截图并定位当前输入框（或视频画面），返回屏幕矩形和可直接照抄的 pet_move_to 落点。做动作前先调它。',
        parameters: {
          type: 'object',
          properties: {
            kind: {
              type: 'string',
              enum: ['input', 'video'],
              description: '定位对象：input = 输入框（默认），video = 视频画面。',
            },
            saveShot: {
              type: 'boolean',
              description: '是否把截图保存到 <dataDir>/logs/stage-shots/（默认 true，只存本地）。',
            },
          },
          additionalProperties: false,
        },
        tags: ['read'],
        handler: async (args = {}) => {
          try {
            return JSON.stringify(await this.#locate(args));
          } catch (error) {
            return `stage_locate 失败：${String(error?.message ?? error)}`;
          }
        },
      },
    ];
  }

  /**
   * stage_locate 的实现：截图 + 定位 + 换算落点。
   * 返回体里 suggestion 是可直接照抄的 `pet_move_to {...}` 字符串；不抢焦点、不注入键鼠。
   */
  async #locate(args = {}) {
    const kind = args?.kind === 'video' ? 'video' : 'input';
    const saveShot = args?.saveShot !== false;
    const fg = this.#safeReadForeground();
    let located;
    if (kind === 'video') {
      located = locateVideo({ foreground: fg, config: this.#config });
    } else {
      located = locateInput({ win32: this.#win32, uia: this.#uia, foreground: fg, config: this.#config });
    }

    const notes = [];
    let shot = null;
    if (saveShot) {
      try {
        shot = await this.#captureShot(kind);
        if (shot && shot.ok !== true) {
          notes.push(`截图失败：${shot.error ?? 'unknown'}`);
          shot = null;
        }
      } catch (error) {
        notes.push(`截图失败：${String(error?.message ?? error)}`);
      }
    }

    const result = buildLocateResult({ kind, located, stage: this.#stage, foreground: fg, shot, notes });
    this.#writeLog('locate', {
      kind,
      ok: result.ok,
      source: result.source,
      rect: result.rect,
      fractions: result.fractions,
      suggestion: result.suggestion,
      element: result.element,
      shotPath: shot?.path ?? null,
      foreground: fg ? { title: shorten(fg.title, 60), exe: fg.exe, pid: fg.pid } : null,
      notes: result.notes,
    });
    return result;
  }

  /** 截一张主屏图到 <dataDir>/logs/stage-shots/，并只保留最近 keep 张。 */
  async #captureShot(kind) {
    const sc = this.#screenshotConfig();
    if (!sc.enabled) return null;
    const dataDir = this.#ctx?.dataDir ? String(this.#ctx.dataDir) : PACKAGE_DIR;
    const dir = join(dataDir, 'logs', 'stage-shots');
    const outPath = join(dir, shotFileName(kind, 'png'));
    const shot = await captureScreenshot({
      outPath,
      maxWidth: sc.maxWidth,
      quality: sc.quality,
      format: 'png',
    });
    if (shot?.ok) await pruneShots(dir, sc.keep);
    return shot;
  }

  /** stage_check 的返回体：开关 + 全屏隐藏风险提示。 */
  #check() {
    const watchEnabled = this.#watchOn();
    const typingEnabled = this.#typingOn();
    const fullscreenVideo = !!this.#video?.fullscreen && !!this.#video?.found;
    return {
      watchEnabled,
      typingEnabled,
      hideWhenFullscreen: !!this.#hideWhenFullscreen,
      fullscreenVideo,
      status: {
        win32: this.#win32 ? 'ok' : this.#win32Error || 'unavailable',
        uia: this.#uia?.running ? 'running' : 'stopped',
        probePort: this.#probe?.port ?? 0,
      },
      note: this.#hideWhenFullscreen
        ? 'hideWhenFullscreen=true：全屏视频时宠物窗口会被隐藏，建议在 companion 配置里关掉 worlds.desktop-pet.window.hideWhenFullscreen。'
        : 'hideWhenFullscreen=false：全屏视频时宠物仍然可见。',
    };
  }

  envPromptVars() {
    const cfg = this.#config;
    return {
      stageStatus: this.#onOff(cfg.enabled !== false),
      stageDisplay: `${this.#stage.width}×${this.#stage.height} @ (${this.#stage.originX},${this.#stage.originY})`,
      stageMoveTargets: 'watch / type / floor / near',
      stageProbePort: this.#probeOn() ? String(this.#probePort()) : 'off',
    };
  }

  webUi(language) {
    const zh = language !== 'en';
    const lamps = [
      {
        label: '感知',
        state: this.#win32 ? 'online' : 'error',
        hint: this.#win32 ? `舞台 ${this.#stage.width}×${this.#stage.height}` : this.#win32Error || 'Win32 不可用',
      },
      {
        label: 'UIA',
        state: this.#uia?.running ? 'online' : this.#win32 ? 'loading' : 'offline',
        hint: this.#uia ? `重启 ${this.#uia.restarts} 次` : '未启动',
      },
      {
        label: '探针',
        state: this.#probe ? 'online' : 'offline',
        hint: this.#probe ? `127.0.0.1:${this.#probe.port}/probe` : '关闭',
      },
    ];
    return {
      label: '看片与打字',
      lamps,
      config: [stageConfigGroup(language)],
      promptDocs: [
        {
          key: 'stage-env-prompt',
          title: zh ? '看片与打字：环境说明' : 'Watch & type guide',
          description: zh
            ? '告诉 Coo：她要看视频/打字时必须先做动作（强制、不可跳过）：stage_locate 定位 → pet_move_to 移动并等返回 → pet_act 摆姿势 → 之后才开始输入/观看，结束必须起身；视频落点是画面底边左下/右下角；四个落点 watch/type/floor/near；用户自己看/打字时不要跑过去。'
            : 'Tells Coo: before SHE watches video or types, actions are mandatory: stage_locate → pet_move_to (wait for it to finish) → pet_act pose → only then start typing/watching, and always end the pose; video target sits at the bottom-left/right corner of the video; four pet_move_to targets; do not react to the user\'s own watching/typing.',
          path: ENV_PROMPT_PATH,
          role: 'envPrompt',
          vars: [
            { name: 'stageStatus', description: zh ? '世界是否启用（on/off）。' : 'World enabled (on/off).' },
            { name: 'stageDisplay', description: zh ? '宠物舞台的像素尺寸与原点。' : 'Pet stage size and origin in px.' },
            { name: 'stageMoveTargets', description: zh ? '可用的 pet_move_to 目标。' : 'Available pet_move_to targets.' },
            { name: 'stageProbePort', description: zh ? '本地探针端口（off 表示关闭）。' : 'Local probe port (off = disabled).' },
          ],
        },
      ],
    };
  }

  /* ------------------------------------------------------------ 当前采样 */

  snapshot() {
    const now = Date.now();
    const fresh = this.#safeReadForeground();
    const fg = fresh ?? this.#lastForeground;
    const uia = this.#uia?.last() ?? null;
    const stage = this.#stage;

    const video = this.#video;
    const videoFractions =
      video.rect && video.active
        ? {
            x0: fracOfX(video.rect.x, stage),
            x1: fracOfX(video.rect.x + video.rect.width, stage),
            y0: fracOfY(video.rect.y, stage),
            y1: fracOfY(video.rect.y + video.rect.height, stage),
          }
        : null;
    const typing = this.#typing?.snapshot(this.#keys, now) ?? {
      active: false,
      app: '',
      element: '',
      source: '',
      rect: null,
      lastKeyAgoMs: -1,
    };
    const typingPointNow = typing.rect ? inputPoint(typing.rect) : null;
    const typingFractions = typing.rect
      ? {
          xc: (fracOfX(typing.rect.x, stage) + fracOfX(typing.rect.x + typing.rect.width, stage)) / 2,
          y1: fracOfY(typing.rect.y + typing.rect.height, stage),
        }
      : null;
    const keyboardLastAt = this.#keys?.lastAt() ?? 0;

    return {
      ts: now,
      iso: nowIso(this.#timeZone),
      kind: video.found ? 'video' : typing.active ? 'typing' : 'idle',
      // 三个 Lead 要求的固定字段（stage_status / stage_probe / HTTP /probe 都会带）。
      watchEnabled: this.#watchOn(),
      typingEnabled: this.#typingOn(),
      hideWhenFullscreen: !!this.#hideWhenFullscreen,
      foreground: fg
        ? {
            title: fg.title,
            exe: fg.exe,
            pid: fg.pid,
            hwnd: fg.hwndHex,
            className: fg.className,
            rect: fg.rect,
          }
        : null,
      display: {
        w: stage.width,
        h: stage.height,
        originX: stage.originX,
        originY: stage.originY,
        scale: stage.scale,
      },
      stage: { ...stage },
      video: {
        found: !!video.found,
        title: video.title || '',
        // Lead 的探针字段约定：source 只有 'cdp' | 'heuristic'（本世界没有 CDP，统一 heuristic）。
        source: video.found ? 'heuristic' : 'none',
        mode: video.source || 'none',
        fullscreen: !!video.fullscreen,
        x0: video.rect ? video.rect.x : 0,
        x1: video.rect ? video.rect.x + video.rect.width : 0,
        y0: video.rect ? video.rect.y : 0,
        y1: video.rect ? video.rect.y + video.rect.height : 0,
        rect: video.rect ? { ...video.rect } : null,
        cooldownMsLeft: Math.max(0, this.#videoCooldownSec() * 1000 - (now - video.emitAt)),
      },
      typing: {
        active: typing.active,
        app: typing.app,
        element: typing.element,
        source: typing.source,
        x: typingPointNow ? typingPointNow.x : 0,
        y: typingPointNow ? typingPointNow.y : 0,
        rect: typing.rect ? { ...typing.rect } : null,
        lastKeyAgoMs: typing.lastKeyAgoMs,
      },
      fractions: {
        // 与事件文本一致：watch 用视频上边缘 y0，type 用输入框下边缘 y1。
        video: videoFractions
          ? { to: 'watch', xc: (videoFractions.x0 + videoFractions.x1) / 2, y: videoFractions.y0, ...videoFractions, px: video.rect }
          : null,
        typing: typingFractions ? { to: 'type', ...typingFractions, py: typing.rect ? typing.rect.y + typing.rect.height : 0 } : null,
      },
      pet: {
        hideWhenFullscreen: this.#hideWhenFullscreen,
        hiddenByFullscreen: !!(video.found && video.fullscreen && this.#hideWhenFullscreen),
      },
      uia: {
        enabled: !!this.#uia,
        running: !!this.#uia?.running,
        restarts: this.#uia?.restarts ?? 0,
        ok: uia?.ok === true,
        editable: uia?.editable === true,
        hwnd: uia?.hwndHex ?? '',
        type: uia?.type ?? '',
        name: uia?.name ?? '',
        rect: uia?.rect ?? null,
        scale: uia?.scale ?? 1,
        ageMs: uia ? Math.max(0, now - uia.at) : -1,
      },
      keyboard: {
        transitionsLast4s: this.#keys?.countSince(now - 4000) ?? 0,
        lastKeyAgoMs: keyboardLastAt ? Math.max(0, now - keyboardLastAt) : -1,
        debug: this.#keyDebug(now),
      },
      win32: {
        available: !!this.#win32,
        error: this.#win32Error,
      },
      probe: { port: this.#probe?.port ?? 0 },
    };
  }

  /* ------------------------------------------------------------ 内部：采样 */

  /** 探针诊断:确认 Core 进程里 GetAsyncKeyState / GetLastInputInfo 到底看得见什么。 */
  #keyDebug() {
    if (!this.#win32) return { error: 'win32 不可用' };
    const out = {};
    try {
      const api = this.#win32.raw();
      out.vkA = Number(api.GetAsyncKeyState(0x41) & 0xffff);
      out.vkShift = Number(api.GetAsyncKeyState(0x10) & 0xffff);
    } catch (error) {
      out.rawError = String(error?.message ?? error);
    }
    try {
      out.idleMs = this.#win32.lastInputIdleMs();
    } catch (error) {
      out.idleError = String(error?.message ?? error);
    }
    try {
      out.keyDownA = !!this.#win32.keyDown(0x41);
    } catch (error) {
      out.keyDownError = String(error?.message ?? error);
    }
    return out;
  }

  #safeReadForeground() {
    if (!this.#win32) return null;
    try {
      const fg = this.#win32.foreground();
      if (!fg) return null;
      const win = {
        ok: true,
        hwnd: fg.hwnd,
        hwndHex: fg.hwndHex,
        pid: fg.pid,
        title: fg.title,
        className: fg.className,
        exe: fg.exe,
        exeName: fg.exe,
        exePath: fg.exePath,
        rect: fg.rect,
        style: fg.style,
        exStyle: fg.exStyle,
        visible: fg.visible,
        iconic: fg.iconic,
        maximized: fg.maximized,
        hasCaption: fg.hasCaption,
        monitor: fg.monitor,
        ownWindow: isOwnWindow(fg, this.#config),
      };
      this.#lastForeground = win;
      return win;
    } catch (error) {
      this.#safeError('foreground', error);
      return null;
    }
  }

  #tick() {
    const now = Date.now();
    const fg = this.#safeReadForeground();
    if (now - this.#flagAt > 15000) {
      this.#flagAt = now;
      void this.#readCompanionFlags().catch(() => {});
    }
    if (this.#watchOn()) this.#safe('video-step', () => this.#videoStep(now, fg));
    if (this.#typing && this.#typingOn()) {
      try {
        this.#typing.update({ foreground: fg, uia: this.#uia?.latest(), keys: this.#keys });
      } catch (error) {
        this.#safeError('typing-update', error);
      }
    }
  }

  #videoStep(now, fg) {
    const cfg = this.#config.video;
    const cooldownMs = this.#videoCooldownSec() * 1000;
    // 标题变化（换视频/暂停后标题加了后缀）比整段视频的冷却更频繁，单独给一个短冷却。
    const titleCooldownMs = this.#titleCooldownSec() * 1000;
    const moveFrac = Number(cfg.rectMoveFrac) > 0 ? Number(cfg.rectMoveFrac) : 0.05;
    const video = this.#video;

    let matched = null;
    if (fg && fg.ok) {
      try {
        matched = detectVideo(fg, this.#config);
      } catch {
        matched = null;
      }
    }

    if (!matched) {
      video.found = false;
      const graceMs = Math.max(1000, Number(cfg.endGraceMs) || 10000);
      if (video.active && now - video.lastMatchAt >= graceMs) {
        const announced = video.announced;
        const endedTitle = video.title;
        video.active = false;
        video.announced = false;
        video.title = '';
        video.rect = null;
        video.fullscreen = false;
        video.source = 'none';
        if (announced) {
          this.#emitLeave('video-end', '视频窗口没了或不再播放。想回桌面底部就调 pet_move_to {to:"floor"}。', {
            title: endedTitle,
          });
        }
      }
      return;
    }

    const titleChanged = video.title !== matched.title;
    const moved = video.rect ? rectMovedFrac(video.rect, matched.rect, this.#stage) >= moveFrac : true;
    const hide = matched.fullscreen && this.#hideWhenFullscreen;
    const sinceEmit = now - video.emitAt;

    let emit = false;
    if (!video.active) emit = sinceEmit >= cooldownMs; // 上一段视频已结束：冷却过后再通报
    else if (titleChanged && sinceEmit >= titleCooldownMs) emit = true; // 换了视频：给个最短间隔再通报，避免浏览器标题抖动刷屏
    else if (moved) emit = sinceEmit >= cooldownMs; // 同一视频移动：受冷却限制

    if (emit) {
      if (hide) {
        // 全屏且宠物被 desktop-pet 世界隐藏：不硬推「爬上去」，等退出全屏再说
        this.#log.info('stage: video fullscreen but pet hidden, skip event');
        this.#writeLog('video-skip-hidden', { title: matched.title, fullscreen: true });
        video.announced = false;
        video.emitAt = now;
      } else {
        this.#emitVideoStart(now, matched);
        video.emitAt = now;
        video.announced = true;
      }
    }

    video.active = true;
    video.found = true;
    video.title = matched.title;
    video.rect = { ...matched.rect };
    video.fullscreen = matched.fullscreen;
    video.source = matched.source;
    video.lastMatchAt = now;
  }

  #emitVideoStart(now, matched) {
    const stage = this.#stage;
    const rect = matched.rect;
    const x0 = fracOfX(rect.x, stage);
    const x1 = fracOfX(rect.x + rect.width, stage);
    const y0 = fracOfY(rect.y, stage);
    const y1 = fracOfY(rect.y + rect.height, stage);
    const xc = (x0 + x1) / 2;
    const title = shorten(cleanTitle(matched.title), 40);
    // 全屏矩形是精确的；浏览器窗口里的 16:9 区域是推算的，按 Lead 要求注明「估计值」。
    const est = matched.source === 'fullscreen' ? '' : '（估计值）';
    // 文本契约（Lead m00097 定稿）：参数 x=横向比例、y=落座高度比例，两位小数；总是给两个数。
    const text =
      `[stage.watch] 用户正在看《${title}》（播放中）。画面区域比例${est} x ${f2(x0)}–${f2(x1)}，y ${f2(y0)}–${f2(y1)}。` +
      `想爬上去看就调 pet_move_to {to:"watch", params:[${f2(xc)}, ${f2(y0)}]}，然后 pet_act {actions:["sit"]}。不想去就忽略。`;
    this.#pushEvent('stage.watch', text).catch(() => {});
    this.#writeLog('video-start', {
      title: matched.title,
      exe: matched.exe,
      fullscreen: matched.fullscreen,
      source: matched.source,
      rect,
      fractions: { x0, x1, y0, y1, xc },
      event: text,
    });
  }

  #onTypingTransition(transition) {
    const session = transition?.session ?? {};
    const rect = session.rect;
    if (!rect) return;
    const stage = this.#stage;
    const y1 = fracOfY(rect.y + rect.height, stage);
    const xc = (fracOfX(rect.x, stage) + fracOfX(rect.x + rect.width, stage)) / 2;
    if (transition.kind === 'start') {
      const app = shorten(session.app || '前台应用', 30);
      const est = session.source === 'heuristic' ? '，估计值' : '';
      const text =
        `[stage.typing] 用户正在「${app}」的输入框里打字（输入框底边比例 y ${f2(y1)}，横向中心 ${f2(xc)}${est}）。` +
        `想过去做动作就调 pet_move_to {to:"type", params:[${f2(xc)}, ${f2(y1)}]}，然后 pet_act {actions:["typepaw"]}。不想去就忽略。`;
      this.#typingPoint = inputPoint(rect);
      this.#typingRect = rect;
      this.#pushEvent('stage.typing', text).catch(() => {});
      this.#writeLog('typing-start', {
        app: session.app,
        element: session.elementName,
        source: session.source,
        rect,
        fractions: { xc, y1 },
        event: text,
      });
    } else if (transition.kind === 'end') {
      this.#typingPoint = null;
      this.#typingRect = null;
      this.#emitLeave('typing-end', '用户离开输入框了。想回桌面底部就调 pet_move_to {to:"floor"}。', {
        app: session.app,
        reason: transition.reason,
      });
    }
  }

  /** [stage.leave] 同时用于「视频结束」「打字结束」，带 5s 去重，避免两边同时结束推两条。 */
  #emitLeave(tag, tail, extra = {}) {
    const now = Date.now();
    if (now - this.#leaveAt < 5000) return;
    this.#leaveAt = now;
    const text = `[stage.leave] ${tail}`;
    this.#pushEvent('stage.leave', text).catch(() => {});
    this.#writeLog(tag, { ...extra, event: text });
  }

  #logSample() {
    const now = Date.now();
    this.#lastSampleLogAt = now;
    const fg = this.#lastForeground;
    const uia = this.#uia?.last() ?? null;
    const video = this.#video;
    const typing = this.#typing?.snapshot(this.#keys, now) ?? null;
    const videoFractions =
      video.rect && video.active
        ? {
            x0: fracOfX(video.rect.x, this.#stage),
            x1: fracOfX(video.rect.x + video.rect.width, this.#stage),
            y0: fracOfY(video.rect.y, this.#stage),
            y1: fracOfY(video.rect.y + video.rect.height, this.#stage),
          }
        : null;
    const typingFractions = typing?.rect
      ? {
          xc: (fracOfX(typing.rect.x, this.#stage) + fracOfX(typing.rect.x + typing.rect.width, this.#stage)) / 2,
          y1: fracOfY(typing.rect.y + typing.rect.height, this.#stage),
        }
      : null;
    this.#writeLog('sample', {
      foreground: fg ? { title: shorten(fg.title, 60), exe: fg.exe, pid: fg.pid } : null,
      ownWindow: fg ? !!fg.ownWindow : null,
      video: {
        hit: !!video.found,
        title: video.title || null,
        fullscreen: !!video.fullscreen,
        rect: video.rect ?? null,
        fractions: videoFractions ?? null,
      },
      typing: {
        active: !!typing?.active,
        source: typing?.source ?? '',
        rect: typing?.rect ?? null,
        fractions: typingFractions ?? null,
        lastKeyAgoMs: typing?.lastKeyAgoMs ?? -1,
      },
      uia: uia ? { ok: uia.ok, editable: uia.editable, type: uia.type, name: shorten(uia.name, 30), ageMs: now - uia.at } : null,
      keys: { last4s: this.#keys?.countSince(now - 4000) ?? 0, lastKeyAgoMs: this.#keys?.lastAt() ? now - this.#keys.lastAt() : -1 },
      petHiddenFullscreen: this.#hideWhenFullscreen,
    });
  }

  /* -------------------------------------------------------- 内部：事件推送 */

  async #pushEvent(type, text, trigger = 'debounce') {
    if (this.#stopped || !this.#host?.pushEvent) return;
    const body = truncate(String(text ?? ''), Math.max(120, Number(this.#config.maxEventChars) || 600));
    const event = {
      type,
      ts: nowIso(this.#timeZone),
      source: this.id,
      senderKey: this.id,
      text: body,
    };
    this.#recentEvents.push({ at: Date.now(), type, text: body });
    if (this.#recentEvents.length > 20) this.#recentEvents.splice(0, this.#recentEvents.length - 20);
    this.#writeLog('push-event', { type, text: body, trigger });
    try {
      await this.#host.pushEvent(event, { trigger });
    } catch (error) {
      this.#log.warn(`stage: pushEvent(${type}) failed: ${error?.message ?? error}`);
      this.#writeLog('push-event-failed', { type, error: String(error?.message ?? error) });
    }
  }

  /* ------------------------------------------------------- 内部：杂项 */

  async #readCompanionFlags() {
    if (this.#hideOverride !== null) return;
    const dataDir = this.#ctx.dataDir;
    if (!dataDir) return;
    try {
      const raw = await readFile(join(String(dataDir), 'home', 'companion', 'config.json'), 'utf8');
      const config = JSON.parse(raw);
      const worlds = config?.worlds && typeof config.worlds === 'object' ? config.worlds : {};
      const entry = Object.entries(worlds).find(([key]) => key.includes('desktop-pet'));
      const value = entry?.[1]?.window?.hideWhenFullscreen;
      if (typeof value === 'boolean') this.#hideWhenFullscreen = value;
    } catch {
      /* 文件不在或格式变化时保持默认 */
    }
  }

  #writeLog(tag, data) {
    try {
      this.#stageLog?.write(tag, data);
    } catch {
      /* ignore */
    }
  }

  #safeLog(level, message) {
    try {
      const fn = this.#host?.log?.[level];
      if (typeof fn === 'function') fn.call(this.#host.log, `stage: ${message}`);
    } catch {
      /* ignore */
    }
  }

  #safe(name, fn) {
    try {
      fn();
    } catch (error) {
      this.#safeError(name, error);
    }
  }

  #safeError(name, error) {
    const key = `${name}:${String(error?.message ?? error)}`;
    const count = (this.#errorCounts.get(key) ?? 0) + 1;
    this.#errorCounts.set(key, count);
    if (count <= 2) {
      this.#log.warn(`${name}: ${String(error?.message ?? error)}`);
      this.#writeLog('error', { name, message: String(error?.message ?? error) });
    }
    if (this.#errorCounts.size > 50) this.#errorCounts.clear();
  }

  #onOff(value) {
    return value ? 'on' : 'off';
  }

  /** 「对用户做反应」是否开启（总开关 + 子开关，两者都开才跑；默认关）。 */
  #watchOn() {
    return this.#config.watchEnabled !== false && this.#config.video?.enabled !== false;
  }

  /** 打字感知是否开启（总开关 + 子开关）。 */
  #typingOn() {
    return this.#config.typingEnabled !== false && this.#config.typing?.enabled !== false;
  }

  /* ------------------------------------------- 配置读取（设置页扁平键优先） */

  /** 视频通报冷却（秒）：扁平键 worlds.stage.videoCooldownSec 优先，兼容 video.cooldownSec。 */
  #videoCooldownSec() {
    return Math.max(0, numOr(this.#config.videoCooldownSec, this.#config.video?.cooldownSec, 90));
  }

  /** 标题变化后重新通报的冷却（秒）。 */
  #titleCooldownSec() {
    return Math.max(5, numOr(this.#config.titleCooldownSec, this.#config.video?.titleCooldownSec, 30));
  }

  /** 探针端口：扁平键 worlds.stage.probePort 优先，兼容 probe.port；返回整数。 */
  #probePort() {
    return Math.round(numOr(this.#config.probePort, this.#config.probe?.port, 19388));
  }

  /** 探针是否开启：端口 > 0 且 probe.enabled 未关。 */
  #probeOn() {
    return this.#probePort() > 0 && this.#config.probe?.enabled !== false;
  }

  /** 打字状态机配置：扁平键 typingCooldownSec 映射到 typing.cooldownSec。 */
  #typingConfig() {
    const typing = this.#config.typing && typeof this.#config.typing === 'object' ? this.#config.typing : {};
    return {
      ...typing,
      cooldownSec: Math.max(5, numOr(this.#config.typingCooldownSec, typing.cooldownSec, 45)),
    };
  }

  /** 截图配置（浏览器设置页的 screenshot.* 旋钮），全部做范围收敛。 */
  #screenshotConfig() {
    const shot = this.#config.screenshot && typeof this.#config.screenshot === 'object' ? this.#config.screenshot : {};
    const maxWidth = Math.round(numOr(shot.maxWidth, 1600));
    const quality = Math.round(numOr(shot.quality, 90));
    const keep = Math.round(numOr(shot.keep, 20));
    return {
      enabled: shot.enabled !== false,
      maxWidth: maxWidth <= 0 ? 0 : Math.min(3840, Math.max(320, maxWidth)),
      quality: Math.min(100, Math.max(10, quality)),
      format: String(shot.format) === 'jpeg' ? 'jpeg' : 'png',
      keep: Math.min(200, Math.max(1, keep)),
    };
  }
}

/* -------------------------------------------------------------- 纯函数助手 */

/** 视频落点：视频矩形下边缘中点（她坐在下边缘）。保留给日志/兼容用。 */
export function videoPoint(rect) {
  if (!rect) return { x: 0, y: 0 };
  return { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height) };
}

/** 屏幕像素 → 舞台横向比例 0..1。 */
export function fracOfX(px, stage) {
  const s = stage || ZERO_STAGE;
  return clamp01((Number(px) - s.originX) / s.width);
}

/** 屏幕像素 → 舞台纵向比例 0..1（0=屏幕顶端，1=屏幕底）。 */
export function fracOfY(px, stage) {
  const s = stage || ZERO_STAGE;
  return clamp01((Number(px) - s.originY) / s.height);
}

/** 事件文本里的数值统一两位小数（Lead 定稿）。 */
export function f2(value) {
  const n = Math.round((Number(value) || 0) * 100) / 100;
  return n.toFixed(2);
}

/** 去掉浏览器加的标题后缀，只留页面标题。 */
export function cleanTitle(raw) {
  return String(raw ?? '')
    .replace(/\s+[-—–]\s+(Microsoft\s+Edge|Google\s+Chrome|Mozilla\s+Firefox|Brave|Vivaldi|Opera|Chromium|Thorium|Zen\s+Browser|Naver\s+Whale)$/i, '')
    .trim();
}

export function rectMovedFrac(a, b, stage) {
  if (!a || !b) return 1;
  const sw = Math.max(1, Number(stage?.width) || Math.max(a.width, b.width, 1));
  const sh = Math.max(1, Number(stage?.height) || Math.max(a.height, b.height, 1));
  const dx = Math.abs(a.x + a.width / 2 - (b.x + b.width / 2)) / sw;
  const dy = Math.abs(a.y + a.height / 2 - (b.y + b.height / 2)) / sh;
  return Math.max(dx, dy);
}

/* --------------------------------------------------------------- 世界声明 */

export default {
  id: WORLD_ID,
  label: '看片与打字',
  defaults: () => structuredClone(DEFAULT_CONFIG),
  create: (ctx) => new StageWorld(ctx),
  describe: {
    tools: [
      {
        name: 'stage_status',
        description:
          '查看桌面现在在干什么：前台窗口、输入框/视频区域和可用的落点。你想「走到某个位置再摆姿势」或要确认坐到哪儿时调用。',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
        tags: ['read'],
        summary: '当前桌面感知快照',
      },
      {
        name: 'stage_probe',
        description:
          '开发者探针：返回当前一次完整采样 JSON（前台窗口、显示器、视频矩形、输入框矩形、宠物是否因全屏隐藏）。用于不开 UI 验证感知。',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
        tags: ['read'],
        summary: '完整采样 JSON',
      },
      {
        name: 'stage_check',
        description: '检查「对用户做反应」的开关（watchEnabled/typingEnabled，默认关），以及宠物是否会因全屏（hideWhenFullscreen）被隐藏。她自己看视频/打字做动作由提示词驱动，没有开关。',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
        tags: ['read'],
        summary: '开关与全屏隐藏检查',
      },
      {
        name: 'stage_locate',
        description:
          '截图并定位当前输入框（或视频画面），返回屏幕矩形和可直接照抄的 pet_move_to 落点。做动作前先调它。',
        parameters: {
          type: 'object',
          properties: {
            kind: {
              type: 'string',
              enum: ['input', 'video'],
              description: '定位对象：input = 输入框（默认），video = 视频画面。',
            },
            saveShot: {
              type: 'boolean',
              description: '是否把截图保存到 <dataDir>/logs/stage-shots/（默认 true，只存本地）。',
            },
          },
          additionalProperties: false,
        },
        tags: ['read'],
        summary: '截图定位输入框/视频并给落点',
      },
    ],
    events: [
      {
        type: 'stage.watch',
        description:
          '可选（默认关）：检测到前台在放视频（B 站/YouTube 等）时发出，正文给 pet_move_to {to:"watch"} 可照抄参数。她自己的看视频动作由环境提示词驱动，不依赖此事件。',
        trigger: 'debounce',
      },
      {
        type: 'stage.typing',
        description:
          '可选（默认关）：检测到用户在输入框打字时发出，正文给 pet_move_to {to:"type"} 可照抄参数。她自己的打字动作由环境提示词驱动，不依赖此事件。',
        trigger: 'debounce',
      },
      {
        type: 'stage.leave',
        description: '可选：视频窗口消失 / 用户离开输入框时发出，提示 pet_move_to {to:"floor"}。默认关。',
        trigger: 'debounce',
      },
    ],
  },
};
