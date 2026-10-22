/** 通用小工具：时间戳、数值收敛、文本截断。 */

/** 部署时区的 ISO 8601（带偏移），事件 ts 用这个。 */
export function nowIso(timeZone) {
  const d = new Date();
  const tz = timeZone || 'Asia/Shanghai';
  let date = null;
  try {
    date = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(d);
  } catch {
    date = null;
  }
  if (!date) return d.toISOString();
  const get = (type) => date.find((p) => p.type === type)?.value ?? '00';
  const y = get('year');
  const mo = get('month');
  const da = get('day');
  const h = get('hour');
  const mi = get('minute');
  const se = get('second');
  let offset = '+00:00';
  try {
    const name = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      timeZoneName: 'longOffset',
    })
      .formatToParts(d)
      .find((p) => p.type === 'timeZoneName')?.value;
    const m = /GMT([+-]\d{2}:\d{2})/.exec(name ?? '');
    if (m) offset = m[1];
  } catch {
    /* 保留 +00:00 */
  }
  return `${y}-${mo}-${da}T${h}:${mi}:${se}${offset}`;
}

export const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
export const clamp01 = (value) => clamp(value, 0, 1);
export const round = (value, digits = 2) => {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
};

/** 长标题截断，避免事件正文超长。 */
export function shorten(text, max = 80) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (s.length <= max) return s;
  return `${s.slice(0, Math.max(1, max - 1))}…`;
}

export function truncate(text, max = 480) {
  const s = String(text ?? '');
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

/** 深合并配置：只合并普通对象，数组整体替换。 */
export function mergeConfig(defaults, patch) {
  if (!patch || typeof patch !== 'object') return structuredClone(defaults);
  const out = structuredClone(defaults);
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    if (Array.isArray(value) || typeof value !== 'object' || value === null) {
      out[key] = value;
    } else if (out[key] && typeof out[key] === 'object' && !Array.isArray(out[key])) {
      out[key] = mergeConfig(out[key], value);
    } else {
      out[key] = structuredClone(value);
    }
  }
  return out;
}

/** 矩形的交叠面积，全屏判定用。 */
export function intersectArea(a, b) {
  const left = Math.max(a.x, b.x);
  const top = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  if (right <= left || bottom <= top) return 0;
  return (right - left) * (bottom - top);
}
