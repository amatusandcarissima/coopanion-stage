/**
 * 截图（stage_locate 用）：纯 Node 实现。
 *
 * - 抓屏：src/win32.js 的 `captureScreen()`（GDI BitBlt，只读，不注入、不抢焦点）。
 * - 编码：纯 JS PNG（node:zlib），不依赖 PowerShell / .NET，也不依赖新 npm 包。
 *
 * 隐私：只有模型主动调用 stage_locate 且 saveShot 不为 false 时才截图；图片只落在
 * <dataDir>/logs/stage-shots/ 本地，不发往任何地方；截图可能包含用户屏幕内容，README 里写明了。
 */
import { mkdir, readdir, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { deflateSync } from 'node:zlib';
import * as win32 from './win32.js';

/** 截图文件名：locate-<kind>-<本地时间戳>.png。 */
export function shotFileName(kind, _format = 'png', at = new Date()) {
  const pad = (n, len = 2) => String(n).padStart(len, '0');
  const stamp =
    `${at.getFullYear()}${pad(at.getMonth() + 1)}${pad(at.getDate())}-` +
    `${pad(at.getHours())}${pad(at.getMinutes())}${pad(at.getSeconds())}-${pad(at.getMilliseconds(), 3)}`;
  return `locate-${kind === 'video' ? 'video' : 'input'}-${stamp}.png`;
}

/* --------------------------------------------------------------- PNG 编码 */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([length, typeBuf, data, crcBuf]);
}

/** RGBA 像素 → PNG（滤波方式 0，标准 zlib deflate）。 */
export function encodePng(rgba, width, height) {
  const w = Math.max(1, Math.floor(width));
  const h = Math.max(1, Math.floor(height));
  const stride = w * 4;
  const raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y += 1) {
    const rowStart = y * (stride + 1);
    raw[rowStart] = 0; // 滤波类型 None
    raw.set(rgba.subarray(y * stride, y * stride + stride), rowStart + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ------------------------------------------------------------- 缩放/抓屏 */

/** BGRA（自顶向下）→ 区域平均缩放后的 RGBA。maxWidth<=0 或无需缩放时只做通道翻转。 */
export function resizeBgra(bgra, width, height, maxWidth = 0) {
  const limit = Math.round(Number(maxWidth) || 0);
  const needScale = limit > 0 && limit < width;
  const outW = needScale ? limit : width;
  const outH = needScale ? Math.max(1, Math.round((height * outW) / width)) : height;
  const rgba = new Uint8Array(outW * outH * 4);
  const fx = width / outW;
  const fy = height / outH;
  for (let oy = 0; oy < outH; oy += 1) {
    const y0 = Math.floor(oy * fy);
    const y1 = Math.max(y0 + 1, Math.floor((oy + 1) * fy));
    for (let ox = 0; ox < outW; ox += 1) {
      const x0 = Math.floor(ox * fx);
      const x1 = Math.max(x0 + 1, Math.floor((ox + 1) * fx));
      let r = 0;
      let g = 0;
      let b = 0;
      let n = 0;
      for (let y = y0; y < y1 && y < height; y += 1) {
        let i = (y * width + x0) * 4;
        for (let x = x0; x < x1 && x < width; x += 1, i += 4) {
          b += bgra[i];
          g += bgra[i + 1];
          r += bgra[i + 2];
          n += 1;
        }
      }
      const o = (oy * outW + ox) * 4;
      rgba[o] = Math.round(r / n);
      rgba[o + 1] = Math.round(g / n);
      rgba[o + 2] = Math.round(b / n);
      rgba[o + 3] = 255;
    }
  }
  return { rgba, width: outW, height: outH };
}

/**
 * 抓一张主屏截图并写成 PNG。
 * @returns {Promise<{ok:boolean, path?:string, format?:string, screenWidth?:number,
 *   screenHeight?:number, imageWidth?:number, imageHeight?:number, bytes?:number,
 *   ms?:number, requestedFormat?:string, error?:string}>}
 */
export async function captureScreenshot({ outPath, maxWidth = 0, quality = 90, format = 'png' } = {}) {
  const started = Date.now();
  try {
    if (!outPath) return { ok: false, error: 'no-out-path' };
    if (!win32.available()) {
      return { ok: false, error: `win32 helper 不可用：${win32.loadFailure() ?? 'koffi 未加载'}` };
    }
    const shot = win32.captureScreen();
    const scaled = resizeBgra(shot.bgra, shot.width, shot.height, maxWidth);
    const png = encodePng(scaled.rgba, scaled.width, scaled.height);
    await mkdir(dirname(outPath), { recursive: true });
    await writeFile(outPath, png);
    return {
      ok: true,
      path: outPath,
      format: 'png',
      requestedFormat: String(format ?? 'png').toLowerCase(),
      quality: Math.round(Number(quality) || 90),
      screenWidth: shot.width,
      screenHeight: shot.height,
      imageWidth: scaled.width,
      imageHeight: scaled.height,
      bytes: png.length,
      ms: Date.now() - started,
    };
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) };
  }
}

/** 截图目录里只保留最近 keep 张，避免无限增长；失败静默。 */
export async function pruneShots(dir, keep = 20) {
  const limit = Math.max(1, Math.round(Number(keep) || 20));
  try {
    await mkdir(dir, { recursive: true });
    const names = (await readdir(dir)).filter((name) => /^locate-.*\.(png|jpg|jpeg)$/i.test(name));
    if (names.length <= limit) return 0;
    const withStat = [];
    for (const name of names) {
      try {
        const info = await stat(join(dir, name));
        withStat.push({ name, at: info.mtimeMs });
      } catch {
        /* ignore */
      }
    }
    withStat.sort((a, b) => b.at - a.at);
    let removed = 0;
    for (const item of withStat.slice(limit)) {
      try {
        await unlink(join(dir, item.name));
        removed += 1;
      } catch {
        /* ignore */
      }
    }
    return removed;
  } catch {
    return 0;
  }
}
