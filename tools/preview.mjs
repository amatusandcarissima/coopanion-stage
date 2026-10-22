/**
 * preview.mjs —— 脱机预览形象包的一个姿势/动作,截图存盘。改了 figure.js 的姿势之后先跑这个,
 * 不用把包装回 Coopanion、也不用打扰桌面上正在跑的她。
 *
 * 原理:用无头 Edge 打开宠物服务自己的页面 http://127.0.0.1:7797/pet,把页面内容换成一个
 * 「假舞台」(1280×800、地板在底部),按 figure-frame 的 postMessage 协议把包的入口挂进去,
 * 喂 tick、发 move/do/set,再截图。真正的包代码、真贴图、真 WebGL,只是舞台是假的。
 *
 * 用法(需要 Coopanion 正在运行,宠物服务端口默认 7797):
 *   node tools/preview.mjs --pose '{"armN":96,"armF":-10,"headTilt":3,"pitch":0.18,"face":"happy"}' --out by-hand.png
 *   node tools/preview.mjs --word bye --at 500,1200 --out bye.png      # 动作词,取多帧
 *   node tools/preview.mjs --to type --x 0.5 --y 0.58 --out type.png   # 走位目标
 *   node tools/preview.mjs --to watch --x 0.5 --y 0.35 --hold 2500 --out watch.png
 *
 * 参数:
 *   --pose <json>     直接覆盖姿态(调参最快);可带 face/look
 *   --word <id>       调 body.do(词必须是 figure.json vocab 里有、且包内认识的)
 *   --to <id>         调 move 目标(watch/type/floor/near,或你在 figure.json 里新加的)
 *   --x <0..1> --y <0..1>  配合 --to 的两个参数
 *   --at <ms,ms,...>  截图时刻(默认 800)
 *   --hold <ms>       只有一个 --at 时,先等这么久再截
 *   --out <name>      输出文件名,默认 preview.png
 *   --width --height  假舞台尺寸,默认 1280×800
 *   --pack <id>       形象包 id,默认 whale-stage
 *   --data <dir>      数据目录,默认读 %LOCALAPPDATA%\Coopanion\data-location.json
 */
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { homedir } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

/* ---------------- 命令行 ---------------- */
const argv = process.argv.slice(2);
const arg = (name, dflt = null) => {
  const i = argv.indexOf('--' + name);
  if (i < 0) return dflt;
  const v = argv[i + 1];
  return v == null || v.startsWith('--') ? true : v;
};
const PACK = String(arg('pack', 'whale-stage'));
const W = Number(arg('width', 1280));
const H = Number(arg('height', 800));
const AT = String(arg('at', '800')).split(',').map(n => Number(n)).filter(n => Number.isFinite(n));
const HOLD = Number(arg('hold', 0));
const S = Number(arg('scale', 0.42));
const OUT = String(arg('out', 'preview.png'));
const WORD = arg('word', null);
const TO = arg('to', null);
const POSE = arg('pose', null);
const POSE_FILE = arg('pose-file', null);
const POSES = arg('poses', null);
const POSES_FILE = arg('poses-file', null);
const X = arg('x', null);
const Y = arg('y', null);

const OUT_DIR = resolve(arg('outdir', process.env.PREVIEW_DIR || join(ROOT, '.preview')));
mkdirSync(OUT_DIR, { recursive: true });
const shots = [];

/* ---------------- 找到数据目录 / 宠物端口 / puppeteer ---------------- */
function dataDir() {
  const explicit = arg('data', null);
  if (explicit && explicit !== true) return String(explicit);
  try {
    const ptr = join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'Coopanion', 'data-location.json');
    const j = JSON.parse(readFileSync(ptr, 'utf8'));
    if (j.path) return j.path;
    if (j.dir) return j.dir;
  } catch { /* 忽略:退回默认 */ }
  return 'E:\\study material\\Coopanion\\data';
}

function petPort() {
  try {
    const cfg = JSON.parse(readFileSync(join(dataDir(), 'home', 'companion', 'config.json'), 'utf8'));
    const p = cfg?.worlds?.['desktop-pet']?.port;
    if (Number.isFinite(p)) return p;
  } catch { /* 用默认 */ }
  return 7797;
}

function puppeteerPath() {
  // 复用应用里装好的 puppeteer-core(浏览器世界依赖它),避免再装一份
  const base = join(dataDir(), 'extensions', 'node_modules', '.pnpm');
  if (existsSync(base)) {
    const { readdirSync } = require('node:fs');
    const dir = readdirSync(base).find(d => d.startsWith('puppeteer-core@'));
    if (dir) {
      const p = join(base, dir, 'node_modules', 'puppeteer-core', 'lib', 'puppeteer', 'puppeteer-core.js');
      if (existsSync(p)) return p;
    }
  }
  throw new Error('找不到 puppeteer-core:请确认 Coopanion 的 browser 世界装着(extensions/node_modules/.pnpm/puppeteer-core@*)');
}
// ESM 里用 require 只是为了同步读目录,补一个
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const PORT = petPort();
const BASE = `http://127.0.0.1:${PORT}`;
const puppeteer = (await import(pathToFileURL(puppeteerPath()).href)).default;

/* ---------------- 起无头浏览器,搭假舞台 ---------------- */
const EDGE = ['C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe']
  .find(p => existsSync(p));

const browser = await puppeteer.launch({
  executablePath: EDGE,
  headless: 'new',
  args: ['--no-sandbox', '--disable-gpu-sandbox', '--force-device-scale-factor=1'],
  defaultViewport: { width: W, height: H },
});
const page = await browser.newPage();
const logs = [];
page.on('console', m => logs.push('[console] ' + m.text()));
page.on('pageerror', e => logs.push('[pageerror] ' + e.message));

await page.goto(`${BASE}/pet`, { waitUntil: 'domcontentloaded', timeout: 20000 });
await new Promise(r => setTimeout(r, 400));

const booted = await page.evaluate(async ({ PACK, W, H, S }) => {
  document.body.innerHTML = '';
  document.body.style.cssText = 'margin:0;background:#e9e9ef;overflow:hidden';
  const packBase = location.origin + '/packs/' + PACK + '/';
  const man = await (await fetch(packBase + 'figure.json')).json();
  const model = man.model ? await (await fetch(packBase + man.model)).json() : null;
  const fake = { frames: 0, layout: null, error: null, ready: false };
  window.__preview = fake;
  let fr = null;
  const post = m => fr?.contentWindow.postMessage(m, '*');
  const bounds = { W, H, floorY: H - 10, S };
  const init = () => post({
    t: 'init', entry: packBase + man.entry, export: man.export, base: packBase, model,
    scheme: (man.presets && man.presets[0] && man.presets[0].pick) || 'harness-cape',
    theme: 'light', language: 'zh',
    start: { x: Math.round(W * .5), facing: 1, enter: 'drop', skin: { figure: PACK, scheme: 'harness-cape', palette: 'mint' } },
    bounds,
  });
  addEventListener('message', e => {
    if (!fr || e.source !== fr.contentWindow) return;
    const m = e.data || {};
    if (m.t === 'loaded') init();
    else if (m.t === 'ready') {
      fake.ready = true;
      // dt 用真实时间差(和 pet-app 的帧循环一致,上限 0.05s):无头浏览器的 rAF 可能远快于 60Hz,
      // 固定 1/60 会让所有动画在墙钟上被加速好几倍,看不出真实节奏。
      let last = 0;
      const loop = now => {
        const dt = last ? Math.min(.05, Math.max(0, (now - last) / 1000)) : 1 / 60;
        last = now;
        post({ t: 'tick', dt });
        requestAnimationFrame(loop);
      };
      requestAnimationFrame(loop);
    } else if (m.t === 'frame') { fake.frames++; if (m.layout) fake.layout = { x: Math.round(m.layout.x), y: Math.round(m.layout.box ? m.layout.box.y : 0), mode: m.layout.mode }; }
    else if (m.t === 'error') fake.error = m.message;
  });
  fr = document.createElement('iframe');
  fr.src = '/figure-frame';
  fr.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;border:0;background:transparent';
  document.body.appendChild(fr);
  return { ok: true, name: man.name, vocab: man.vocab?.length, moves: (man.moves || []).map(m => m.id) };
}, { PACK, W, H, S });

await page.waitForFunction(() => window.__preview && window.__preview.ready, { timeout: 30000 });
await new Promise(r => setTimeout(r, 500)); // 再等几帧,让 enter 落地/首帧姿势稳定

/* ---------------- 发指令 ---------------- */
if (POSE) {
  let pose;
  try { pose = JSON.parse(POSE_FILE && POSE_FILE !== true ? readFileSync(String(POSE_FILE), 'utf8') : String(POSE)); } catch (e) { throw new Error('--pose/--pose-file 不是合法 JSON:' + e.message); }
  await page.evaluate(p => {
    // 用 page 上的 iframe 引用发消息:直接复用 post 通道
    const fr = document.querySelector('iframe');
    const msg = { t: 'set', state: { devPose: p } };
    fr?.contentWindow?.postMessage(msg, '*');
  }, pose);
}
if (POSES || POSES_FILE) {
  const list = JSON.parse(POSES_FILE && POSES_FILE !== true ? readFileSync(String(POSES_FILE), 'utf8') : String(POSES));
  await page.evaluate(w => document.querySelector('iframe')?.contentWindow?.postMessage({ t: 'set', state: { roam: 'off' } }, '*'), 0);
  await page.evaluate(w => document.querySelector('iframe')?.contentWindow?.postMessage({ t: 'place', x: w / 2, facing: 1 }, '*'), W);
  for (let i = 0; i < list.length; i++) {
    const item = list[i];
    const { name, ...pose } = item;
    await page.evaluate(p => document.querySelector('iframe')?.contentWindow?.postMessage({ t: 'set', state: { devPose: p } }, '*'), pose);
    await new Promise(r => setTimeout(r, 550));
    const file = join(OUT_DIR, `pose-${String(i).padStart(2, '0')}-${name || 'v'}.png`);
    await page.screenshot({ path: file });
    shots.push(file);
  }
}
if (WORD) {
  await page.evaluate(w => document.querySelector('iframe')?.contentWindow?.postMessage({ t: 'do', word: w }, '*'), String(WORD));
}
if (TO) {
  const params = {};
  if (X != null) params.x = Number(X);
  if (Y != null) params.y = Number(Y);
  await page.evaluate(({ to, params }) => document.querySelector('iframe')?.contentWindow?.postMessage(
    { t: 'move', id: 8801, args: { to, run: false, params } }, '*'), { to: String(TO), params });
}

/* ---------------- 截图 ---------------- */
const times = HOLD > 0 && AT.length === 1 ? [HOLD] : (AT.length ? AT : [800]);
let prev = 0;
for (const t of times) {
  const wait = Math.max(0, t - prev);
  if (wait) await new Promise(r => setTimeout(r, wait));
  prev = t;
  const name = times.length > 1 ? OUT.replace(/\.png$/i, `-${t}ms.png`) : OUT;
  const file = join(OUT_DIR, name);
  await page.screenshot({ path: file });
  shots.push(file);
}

/* ---------------- 汇报 ---------------- */
const state = await page.evaluate(() => window.__preview && { frames: window.__preview.frames, layout: window.__preview.layout, error: window.__preview.error, ready: window.__preview.ready });
await browser.close();

console.log(JSON.stringify({
  pack: booted.name, vocab: booted.vocab, moves: booted.moves,
  ready: state?.ready, frames: state?.frames, layout: state?.layout, error: state?.error,
  shots, logs,
}, null, 2));
if (state?.error) process.exitCode = 1;
