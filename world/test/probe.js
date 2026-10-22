/**
 * 感知探针：不需要启动 Coopanion，直接验证 win32 helper 与 UIA 助手。
 *
 *   node test\probe.js           # 默认：窗口信息 + 工作区 + 空闲 + 按键 5s + UIA 10s
 *   PROBE_KEY_MS=3000 PROBE_UIA_MS=8000 node test\probe.js
 *
 * 只读：不会点击、不会输入、不会改任何设置。
 */
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

import * as win32 from '../src/win32.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const KEY_MS = Number(process.env.PROBE_KEY_MS) || 5000;
const UIA_MS = Number(process.env.PROBE_UIA_MS) || 10000;

function hwndHex(hwnd) {
  try {
    return win32.raw().koffi.address(hwnd).toString(16);
  } catch {
    return String(hwnd);
  }
}

function section(title, value) {
  console.log(`\n=== ${title} ===`);
  console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2));
}

if (!win32.available()) {
  console.error(`win32 helper 不可用: ${win32.loadFailure()}`);
  process.exitCode = 1;
} else {
  section('显示器与工作区', {
    dpi: win32.systemDpi(),
    workArea: win32.workArea(),
    displays: win32.displayWorkAreas(),
  });

  const fg = win32.foreground();
  section('前台窗口', fg ? { ...fg, hwndHex: fg.hwndHex ?? hwndHex(fg.hwnd) } : null);

  const all = win32.windows();
  section(`可见窗口（${all.length} 个）`, all.slice(0, 15));

  section('空闲时间', { lastInputIdleMs: win32.lastInputIdleMs() });

  // 按键轮询：只统计「按下」的瞬间，不读字符。
  console.log(`\n=== 按键轮询 ${KEY_MS}ms（请随便敲几下，或看着不动） ===`);
  const seen = new Set();
  let transitions = 0;
  const before = win32.pressedKeys();
  for (const vk of before) seen.add(vk);
  const started = Date.now();
  await new Promise((resolve) => {
    const timer = setInterval(() => {
      try {
        const down = new Set(win32.pressedKeys());
        for (const vk of down) if (!seen.has(vk)) transitions += 1;
        seen.clear();
        for (const vk of down) seen.add(vk);
      } catch (error) {
        console.error(`pressedKeys 失败: ${error?.message ?? error}`);
      }
      if (Date.now() - started >= KEY_MS) {
        clearInterval(timer);
        resolve();
      }
    }, 80);
  });
  console.log(`按键按下次数：${transitions}（最近 2s 空闲 ${win32.lastInputIdleMs()}ms）`);

  // UIA 助手：直接跑同一个脚本，打印解析后的 JSON 行。
  console.log(`\n=== UIA 助手 ${UIA_MS}ms ===`);
  const script = join(HERE, '..', 'src', 'uia-watch.ps1');
  const child = spawn(
    process.env.SystemRoot ? `${process.env.SystemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe` : 'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script],
    { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
  );
  let lines = 0;
  if (child.stdout) {
    child.stdout.setEncoding('utf8');
    createInterface({ input: child.stdout, crlfDelay: Infinity }).on('line', (line) => {
      const text = String(line ?? '').trim();
      if (!text || text[0] !== '{') return;
      lines += 1;
      if (lines <= 40) {
        try {
          console.log(JSON.stringify(JSON.parse(text)));
        } catch {
          console.log(`(无法解析) ${text.slice(0, 200)}`);
        }
      }
    });
  }
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk) => console.error(`[uia stderr] ${String(chunk).trim()}`));
  child.on('error', (error) => console.error(`[uia spawn] ${error?.message ?? error}`));
  await new Promise((resolve) => setTimeout(resolve, UIA_MS));
  try {
    child.kill();
  } catch {
    /* ignore */
  }
  console.log(`\nUIA 行数：${lines}（240ms 一条，${Math.round(UIA_MS / 240)} 条左右算正常）`);
}
