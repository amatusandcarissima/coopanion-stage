/**
 * UIA 聚焦元素探测器的 Node 侧：拉起 `uia-watch.ps1`，逐行读 UTF-8 JSON。
 * - 子进程死了按 1s→2s→4s…最多 30s 的退避重启（stop 后不再重启）。
 * - 解析失败的行只是忽略；最新样本带到达时间，状态机只在样本新鲜时采信。
 * - stop() 先 kill，500ms 后还不退就 taskkill /T 收整棵进程树。
 */
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

export class UiaWatcher {
  #scriptPath;
  #log;
  #child = null;
  #latest = null;
  #stderrTail = '';
  #restarts = 0;
  #startedAt = 0;
  #stopped = false;
  #restartTimer = null;
  #backoffMs;
  #maxBackoffMs;
  #killTimer = null;

  constructor({ scriptPath, log = null, backoffMs = 1000, maxBackoffMs = 30000 } = {}) {
    this.#scriptPath = scriptPath;
    this.#log = log;
    this.#backoffMs = Math.max(250, Number(backoffMs) || 1000);
    this.#maxBackoffMs = Math.max(this.#backoffMs, Number(maxBackoffMs) || 30000);
  }

  /** 是否已经起过且目前没被停掉。 */
  get running() {
    return !this.#stopped && this.#child !== null;
  }

  get restarts() {
    return this.#restarts;
  }

  get stderrTail() {
    return this.#stderrTail;
  }

  start() {
    if (this.#stopped) return;
    this.#spawnOnce();
  }

  #spawnOnce() {
    if (this.#stopped) return;
    this.#startedAt = Date.now();
    let child = null;
    try {
      child = spawn(
        process.env.SystemRoot ? `${process.env.SystemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe` : 'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', this.#scriptPath],
        { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
      );
    } catch (error) {
      this.#log?.warn?.(`stage: uia spawn failed: ${error?.message ?? error}`);
      this.#scheduleRestart();
      return;
    }
    this.#child = child;
    this.#stderrTail = '';
    let ended = false;

    child.stdout?.setEncoding('utf8');
    if (child.stdout) {
      const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
      rl.on('line', (line) => this.#onLine(line));
    }
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk) => {
      this.#stderrTail = (this.#stderrTail + String(chunk)).slice(-2000);
    });
    child.on('error', (error) => {
      if (ended) return;
      ended = true;
      this.#stderrTail = (this.#stderrTail + ` ${error?.message ?? error}`).slice(-2000);
      this.#onExit(null);
    });
    child.on('close', (code) => {
      if (ended) return;
      ended = true;
      this.#onExit(code);
    });
  }

  #onLine(rawLine) {
    const text = String(rawLine ?? '').replace(/^\uFEFF/, '').trim();
    if (!text || text[0] !== '{') return;
    let parsed = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      return;
    }
    if (!parsed || typeof parsed !== 'object') return;
    if (parsed.t === 'ready') {
      this.#log?.info?.('stage: uia helper ready');
      return;
    }
    if (parsed.t !== 'focus') return;
    const sample = {
      ok: parsed.ok === true,
      at: Date.now(),
      hwnd: Number(parsed.hwnd) || 0,
      pid: Number(parsed.pid) || 0,
      type: typeof parsed.type === 'string' ? parsed.type : '',
      value: parsed.value === true,
      readonly: parsed.readonly !== false,
      text: parsed.text === true,
      editable: parsed.editable === true,
      name: typeof parsed.name === 'string' ? parsed.name : '',
      rect:
        parsed.rect && typeof parsed.rect === 'object'
          ? {
              x: Number(parsed.rect.x) || 0,
              y: Number(parsed.rect.y) || 0,
              width: Number(parsed.rect.w) || 0,
              height: Number(parsed.rect.h) || 0,
            }
          : null,
      scale: Number(parsed.scale) > 0 ? Number(parsed.scale) : 1,
      dpi: Number(parsed.dpi) || 96,
      error: typeof parsed.error === 'string' ? parsed.error : undefined,
    };
    sample.hwndHex = sample.hwnd ? sample.hwnd.toString(16) : '';
    this.#latest = sample;
  }

  #onExit(code) {
    this.#child = null;
    if (this.#stopped) return;
    this.#restarts += 1;
    const detail = this.#stderrTail ? ` stderr=${JSON.stringify(this.#stderrTail.slice(-300))}` : '';
    this.#log?.warn?.(`stage: uia helper exited (code=${code}, restarts=${this.#restarts})${detail}`);
    this.#scheduleRestart();
  }

  #scheduleRestart() {
    if (this.#stopped || this.#restartTimer) return;
    const delay = Math.min(this.#maxBackoffMs, this.#backoffMs * 2 ** Math.min(this.#restarts, 5));
    this.#restartTimer = setTimeout(() => {
      this.#restartTimer = null;
      try {
        this.#spawnOnce();
      } catch (error) {
        this.#log?.warn?.(`stage: uia restart failed: ${error?.message ?? error}`);
        this.#scheduleRestart();
      }
    }, delay);
    this.#restartTimer.unref?.();
  }

  /** 最新样本；`maxAgeMs` 内才算新鲜（默认 2.5s，脚本 250ms 一轮）。 */
  latest(maxAgeMs = 2500) {
    if (!this.#latest) return null;
    if (Date.now() - this.#latest.at > maxAgeMs) return null;
    return this.#latest;
  }

  /** 任意最新样本（不看新鲜度），探针用。 */
  last() {
    return this.#latest;
  }

  stop() {
    this.#stopped = true;
    if (this.#restartTimer) clearTimeout(this.#restartTimer);
    this.#restartTimer = null;
    const child = this.#child;
    this.#child = null;
    if (!child) return;
    const pid = child.pid;
    try {
      if (child.exitCode === null && !child.killed) child.kill();
    } catch {
      /* ignore */
    }
    // 子进程不退就收进程树；定时器 unref，不挡进程退出。
    this.#killTimer = setTimeout(() => {
      try {
        if (pid && child.exitCode === null) {
          spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }).on('error', () => {});
        }
      } catch {
        /* ignore */
      }
    }, 500);
    this.#killTimer.unref?.();
  }
}
