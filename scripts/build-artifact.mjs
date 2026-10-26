// Prepares the app for sharing as a claude.ai artifact:
//   dist/index.html  index.html without its document wrapper (doctype, html/head/body,
//                    charset and viewport metas), which the artifact host adds itself
//   dist/files.json  every file the page loads at runtime (src/ and assets/), to publish alongside it
import { readFile, readdir, writeFile, mkdir } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const html = await readFile(resolve(root, 'index.html'), 'utf8');

const page = html
  .replace(/<!doctype html>\s*/i, '')
  .replace(/<\/?html[^>]*>\s*/gi, '')
  .replace(/<\/?head>\s*/gi, '')
  .replace(/<\/?body>\s*/gi, '')
  .replace(/<meta charset[^>]*>\s*/i, '')
  .replace(/<meta name="viewport"[^>]*>\s*/i, '');

// assets/incoming/ is the drop folder for new manufacturer downloads, not part of the app.
const SKIP = new Set(['assets/incoming']);

async function walk(dir) {
  const out = [];
  for (const e of await readdir(join(root, dir), { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (SKIP.has(p.replaceAll('\\', '/'))) continue;
    if (e.isDirectory()) out.push(...(await walk(p)));
    else out.push(relative(root, join(root, p)).replaceAll('\\', '/'));
  }
  return out;
}
const files = [...(await walk('src')), ...(await walk('assets'))].sort();

await mkdir(resolve(root, 'dist'), { recursive: true });
await writeFile(resolve(root, 'dist/index.html'), page);
await writeFile(resolve(root, 'dist/files.json'), JSON.stringify(files, null, 2));
console.log(`Wrote dist/index.html and dist/files.json (${files.length} files to publish alongside)`);
