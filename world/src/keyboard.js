/**
 * 键盘活动脉冲：只用 GetAsyncKeyState 轮询「物理键按下」的上升沿，
 * 不抓按键内容、不装钩子、不读输入。用于判断「正在打字」而非记录打了什么。
 */

/** 可打印键 + 空格/退格 + 小键盘：0x08, 0x20-0x5A, 0x60-0x6F, 0xBA-0xDE。 */
export function printableVkList() {
  const vks = [0x08, 0x0d];
  for (let vk = 0x20; vk <= 0x5a; vk += 1) vks.push(vk);
  for (let vk = 0x60; vk <= 0x6f; vk += 1) vks.push(vk);
  for (let vk = 0xba; vk <= 0xde; vk += 1) vks.push(vk);
  return vks;
}

export class KeyPulse {
  #getAsyncKeyState;
  #vks;
  #down = new Map();
  #events = [];
  #listeners = new Set();
  #windowMs = 5000;
  #lastPolledAt = 0;

  constructor({ getAsyncKeyState, vks = printableVkList(), windowMs = 5000 } = {}) {
    if (typeof getAsyncKeyState !== 'function') throw new TypeError('KeyPulse 需要 getAsyncKeyState');
    this.#getAsyncKeyState = getAsyncKeyState;
    this.#vks = Array.isArray(vks) && vks.length ? vks.slice() : printableVkList();
    this.#windowMs = Math.max(1000, Number(windowMs) || 5000);
  }

  /** 每次轮询调用一次（index.js 里 ~80ms）。返回本次新增的按下次数。 */
  tick(now = Date.now()) {
    this.#lastPolledAt = now;
    let added = 0;
    for (const vk of this.#vks) {
      let down = false;
      try {
        down = (Number(this.#getAsyncKeyState(vk)) & 0x8000) !== 0;
      } catch {
        down = false;
      }
      const prev = this.#down.get(vk) === true;
      this.#down.set(vk, down);
      if (down && !prev) {
        added += 1;
        this.#events.push(now);
      }
    }
    if (added > 0) {
      const cutoff = now - this.#windowMs;
      if (this.#events.length > 0 && this.#events[0] < cutoff) {
        this.#events = this.#events.filter((at) => at >= cutoff);
      }
      for (const listener of this.#listeners) {
        try {
          listener(now, added);
        } catch {
          /* 监听器异常不影响轮询 */
        }
      }
    }
    return added;
  }

  /** 距 since 之后的按下次数（只数窗口内的脉冲）。 */
  countSince(since) {
    const from = Number(since) || 0;
    let count = 0;
    for (const at of this.#events) if (at >= from) count += 1;
    return count;
  }

  lastAt() {
    return this.#events.length ? this.#events[this.#events.length - 1] : 0;
  }

  /** 监听按下事件（用于打字状态下微调节流）。 */
  onPulse(listener) {
    if (typeof listener !== 'function') return () => {};
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  reset() {
    this.#events = [];
    this.#down.clear();
  }

  get lastPolledAt() {
    return this.#lastPolledAt;
  }
}
