/**
 * 本地探针 HTTP 服务（只监听 127.0.0.1，只读）：
 *   GET  /probe  → 与 stage_probe 工具相同的 JSON
 *   GET  /health → {ok:true}
 *   POST /event  → body {type, text}，把自定义事件交给世界推给 Companion（调试用）
 * 端口 config.probe.port，0 = 关闭；默认 19388，避开 7797/17788/19387/9223/3517。
 */
import { createServer } from 'node:http';

export async function startProbeServer({ port, host = '127.0.0.1', snapshot, onEvent, log = null } = {}) {
  const desired = Number(port) || 0;
  if (!desired) return null;
  return await new Promise((resolve) => {
    let server = null;
    try {
      server = createServer((req, res) => {
        try {
          const url = new URL(req.url ?? '/', `http://${host}`);
          if (req.method === 'GET' && (url.pathname === '/probe' || url.pathname === '/')) {
            sendJson(res, 200, snapshot());
            return;
          }
          if (req.method === 'GET' && url.pathname === '/health') {
            sendJson(res, 200, { ok: true, ts: new Date().toISOString() });
            return;
          }
          if (req.method === 'POST' && url.pathname === '/event') {
            readBody(req, 64 * 1024)
              .then((body) => {
                let parsed = null;
                try {
                  parsed = JSON.parse(body);
                } catch {
                  parsed = null;
                }
                if (!parsed || typeof parsed.type !== 'string' || typeof parsed.text !== 'string') {
                  sendJson(res, 400, { ok: false, error: 'body 需要 {"type":"..","text":".."}' });
                  return;
                }
                if (typeof onEvent === 'function') onEvent(parsed);
                sendJson(res, 200, { ok: true });
              })
              .catch((error) => sendJson(res, 400, { ok: false, error: String(error?.message ?? error) }));
            return;
          }
          sendJson(res, 404, { ok: false, error: 'not-found' });
        } catch (error) {
          try {
            sendJson(res, 500, { ok: false, error: String(error?.message ?? error) });
          } catch {
            /* ignore */
          }
        }
      });
    } catch (error) {
      log?.warn?.(`stage: probe server 创建失败: ${error?.message ?? error}`);
      resolve(null);
      return;
    }
    server.on('error', (error) => {
      log?.warn?.(`stage: probe server 监听 ${host}:${desired} 失败: ${error?.message ?? error}`);
      resolve(null);
    });
    server.listen(desired, host, () => {
      const actual = server.address()?.port ?? desired;
      log?.info?.(`stage: probe server http://${host}:${actual}/probe`);
      resolve({
        port: actual,
        close: () =>
          new Promise((done) => {
            try {
              server.close(() => done());
            } catch {
              done();
            }
          }),
      });
    });
  });
}

function sendJson(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
