// Minimal static server for local development: `npm start`, then open the printed URL.
// (ES modules don't load from file://, so index.html needs to be served over http.)
//
// Text files (the OBJ models, scripts, JSON) are sent compressed when the browser accepts it,
// brotli or gzip, as any real host would: the furniture models shrink about 3.5×. Each file is
// compressed once per version and kept in memory. Every response carries an ETag and must be
// revalidated (no-cache), so a reload gets "304 Not Modified" for what hasn't changed and an
// edit always shows on the next load.
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { brotliCompressSync, gzipSync, constants as zlib } from 'node:zlib';

const root = resolve(import.meta.dirname, '..');
const port = Number(process.env.PORT) || 5173;
const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.obj': 'text/plain; charset=utf-8',
  '.bin': 'application/octet-stream',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
};
// Worth compressing: text, and the neighbourhood's raw float arrays (about 2× smaller).
const compressible = new Set(['.html', '.js', '.mjs', '.css', '.json', '.obj', '.gltf', '.svg', '.bin']);
const packed = new Map(); // `${file}|${etag}|${encoding}` → Buffer

function encodingFor(req, ext) {
  if (!compressible.has(ext)) return null;
  const accept = String(req.headers['accept-encoding'] ?? '');
  if (/\bbr\b/.test(accept)) return 'br';
  if (/\bgzip\b/.test(accept)) return 'gzip';
  return null;
}

createServer(async (req, res) => {
  let path;
  try {
    path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  } catch {
    // A malformed escape (e.g. "/%E0") would otherwise throw out of the handler and stop the server.
    res.writeHead(400).end('Bad request');
    return;
  }
  const file = normalize(join(root, path.endsWith('/') ? `${path}index.html` : path));
  // Compare against root plus a separator, or "../living-room-other" would pass a plain prefix test.
  if (file !== root && !file.startsWith(root + sep)) {
    res.writeHead(403).end();
    return;
  }
  try {
    const info = await stat(file);
    if (!info.isFile()) throw new Error('not a file');
    const ext = extname(file).toLowerCase();
    const encoding = encodingFor(req, ext);
    const etag = `"${info.size.toString(36)}-${Math.round(info.mtimeMs).toString(36)}${encoding ? `-${encoding}` : ''}"`;
    const headers = {
      'Content-Type': types[ext] ?? 'application/octet-stream',
      'Cache-Control': 'no-cache',
      ETag: etag,
      ...(compressible.has(ext) && { Vary: 'Accept-Encoding' }),
    };
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, headers).end();
      return;
    }
    let body = await readFile(file);
    if (encoding) {
      const key = `${file}|${etag}`;
      if (!packed.has(key)) {
        packed.set(key, encoding === 'br'
          ? brotliCompressSync(body, { params: { [zlib.BROTLI_PARAM_QUALITY]: 6, [zlib.BROTLI_PARAM_SIZE_HINT]: body.length } })
          : gzipSync(body, { level: 6 }));
      }
      body = packed.get(key);
      headers['Content-Encoding'] = encoding;
    }
    headers['Content-Length'] = body.length;
    res.writeHead(200, headers);
    res.end(req.method === 'HEAD' ? undefined : body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
  }
}).listen(port, () => console.log(`Living room → http://localhost:${port}`));
