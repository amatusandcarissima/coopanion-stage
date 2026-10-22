/**
 * 调试日志：追加写 `<dataDir>\logs\stage.log`，一行一条 ISO 时间戳 + JSON。
 * 不经过 Core 日志也能验证感知是否正确（Lead 的验收要求）。
 * 写失败只吞掉，绝不影响世界运行；文件超过 8MB 时轮转一次。
 */
import { appendFile, mkdir, rename, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const MAX_BYTES = 8 * 1024 * 1024;

export class StageLog {
  #path = '';
  #ready = false;
  #queue = Promise.resolve();
  #enabled;
  #console;

  constructor({ dataDir, enabled = true, consoleLog = null } = {}) {
    this.#enabled = enabled !== false;
    this.#console = typeof consoleLog === 'function' ? consoleLog : null;
    try {
      if (this.#enabled && dataDir) this.#path = join(String(dataDir), 'logs', 'stage.log');
    } catch {
      this.#path = '';
    }
  }

  get path() {
    return this.#path;
  }

  get enabled() {
    return this.#enabled && !!this.#path;
  }

  /** 一条结构化记录：tag 区分种类，data 是任意可 JSON 化对象。 */
  write(tag, data = {}) {
    if (this.#console) {
      try {
        this.#console(`stage: ${tag}`);
      } catch {
        /* ignore */
      }
    }
    if (!this.enabled) return;
    const line = `${new Date().toISOString()} ${safeJson({ tag, ...data })}`;
    this.#queue = this.#queue.then(() => this.#append(line)).catch(() => {});
  }

  async #append(line) {
    try {
      await mkdir(dirname(this.#path), { recursive: true });
      if (!this.#ready) {
        this.#ready = true;
        try {
          const info = await stat(this.#path);
          if (info.size > MAX_BYTES) await rename(this.#path, `${this.#path}.1`).catch(() => {});
        } catch {
          /* 文件还不存在 */
        }
      }
      await appendFile(this.#path, `${line}\n`, 'utf8');
    } catch {
      /* 日志失败不冒泡 */
    }
  }

  /** 退出前把队列刷完（最多等 300ms），stop() 用。 */
  async flush() {
    await Promise.race([this.#queue, new Promise((resolve) => setTimeout(resolve, 300).unref?.())]);
  }
}

function safeJson(value) {
  try {
    return JSON.stringify(value, (_key, val) => (typeof val === 'bigint' ? Number(val) : val));
  } catch {
    return JSON.stringify({ tag: 'log-encode-error' });
  }
}
