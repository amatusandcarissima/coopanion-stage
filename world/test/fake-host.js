/**
 * 假 host 跑世界：不需要 Coopanion，也不需要模型。
 *
 *   node test\fake-host.js                  # 跑 60 秒，打印收到的每个事件
 *   STAGE_SECONDS=20 node test\fake-host.js # 缩短
 *   STAGE_DATA_DIR=D:\某目录 node test\fake-host.js
 *
 * 世界这边只会 pushEvent；这里把事件打印出来，等价于「模型看到了什么」。
 */
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import world, { DEFAULT_CONFIG } from '../src/index.js';

const SECONDS = Math.max(3, Number(process.env.STAGE_SECONDS) || 60);
const DATA_DIR = process.env.STAGE_DATA_DIR || 'D:\\为鲸鲸准备的临时文件夹\\stage-test-data';
await mkdir(DATA_DIR, { recursive: true }).catch(() => {});

const ctx = {
  id: 'stage',
  cfg: {
    ...DEFAULT_CONFIG,
    enabled: true,
    // 探针固定端口可能和别人冲突，测试里关掉；要看 HTTP 就把 STAGE_PROBE=1。
    probe: { enabled: process.env.STAGE_PROBE === '1', host: '127.0.0.1', port: Number(process.env.STAGE_PROBE_PORT) || 19388 },
    debug: { log: true, console: false, sampleLogSec: 10 },
  },
  timezone: 'Asia/Hong_Kong',
  botId: 'x',
  botDir: DATA_DIR,
  packageDir: 'x',
  dataDir: DATA_DIR,
  repoRoot: 'x',
  secret: () => '',
  storeSecret() {},
  persist() {},
  restart: async () => {},
};

const events = [];
const host = {
  pushEvent: async (event) => {
    events.push(event);
    console.log(`\n[${event.ts}] ${event.type} (source=${event.source})\n${event.text}`);
  },
  log: {
    info: (message) => console.log(`[log] ${message}`),
    warn: (message) => console.warn(`[warn] ${message}`),
    error: (message) => console.error(`[error] ${message}`),
  },
  store: {},
  modelFacts: {},
};

const instance = world.create(ctx);
const startedAt = Date.now();
await instance.start(host);
console.log(`世界已启动：${world.id}（${world.label}），dataDir=${DATA_DIR}，跑 ${SECONDS}s`);

// 让 stage_status 也走一遍，确认工具能返回 JSON。
await new Promise((resolve) => setTimeout(resolve, 1500));
for (const tool of instance.tools?.() ?? []) {
  try {
    const result = await tool.handler({});
    console.log(`\n[tool] ${tool.name} → ${String(result).slice(0, 400)}`);
  } catch (error) {
    console.error(`[tool] ${tool.name} 失败: ${error?.message ?? error}`);
  }
}

const reportTimer = setInterval(() => {
  const snapshot = instance.snapshot?.();
  if (!snapshot) return;
  console.log(
    `[snapshot ${Math.round((Date.now() - startedAt) / 1000)}s] kind=${snapshot.kind} fg=${snapshot.foreground?.title?.slice(0, 40) ?? '-'} video=${snapshot.video.found} typing=${snapshot.typing.active} lastKeyAgoMs=${snapshot.keyboard.lastKeyAgoMs}`,
  );
}, 10000);

await new Promise((resolve) => setTimeout(resolve, SECONDS * 1000));
clearInterval(reportTimer);
await instance.stop();
await instance.stop(); // 重复 stop 必须安全

console.log(`\n共收到 ${events.length} 个事件：`);
for (const event of events) console.log(`- ${event.type}: ${event.text.slice(0, 160)}`);
console.log('\nstage.log 在', join(DATA_DIR, 'logs', 'stage.log'));
process.exit(0);
