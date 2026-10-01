import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, extname, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.CAGE_PORT || 8877);
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json', '.css': 'text/css; charset=utf-8', '.glb': 'model/gltf-binary', '.png': 'image/png', '.svg': 'image/svg+xml' };
createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (req.method === 'POST' && url.pathname === '/api/export') {
      let body = ''; for await (const chunk of req) { body += chunk; if (body.length > 15_000_000) throw new Error('Export too large'); }
      const data = JSON.parse(body);
      const state = data.state || {};
      const modes = [typeof state.fitContacts === 'boolean' ? `rest-${state.fitContacts ? 'on' : 'off'}` : null, typeof state.contact === 'boolean' ? `pose-${state.contact ? 'on' : 'off'}` : null, typeof state.fitted === 'boolean' ? (state.fitted ? 'fit' : 'source') : null].filter(Boolean).join('-');
      const tag = `${state.mannequin ? state.mannequin + '-' : ''}${state.garment || 'model'}-${state.pose || 'stand'}-${Math.round((state.width || 1) * 100)}${modes ? '-' + modes : ''}`.replace(/[^a-z0-9_-]/gi, '');
      const name = `fitted-cage-${tag}.json`;
      await mkdir(resolve(root, 'exports'), { recursive: true });
      await writeFile(resolve(root, 'exports', name), JSON.stringify(data));
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true, url: '/exports/' + name, name })); return;
    }
    if (req.method === 'POST' && url.pathname === '/api/evidence') {
      let body = ''; for await (const chunk of req) { body += chunk; if (body.length > 15_000_000) throw new Error('Evidence too large'); }
      const data = JSON.parse(body);
      await mkdir(resolve(root, 'evidence'), { recursive: true });
      const name = String(data.name || 'capture').replace(/[^a-z0-9_-]/gi, '').slice(0, 80);
      if (data.image) await writeFile(resolve(root, 'evidence', name + '.png'), Buffer.from(data.image.replace(/^data:image\/png;base64,/, ''), 'base64'));
      await writeFile(resolve(root, 'evidence', name + '.json'), JSON.stringify({ ...data, image: undefined }, null, 2));
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true, name })); return;
    }
    const pathname = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
    const path = resolve(root, '.' + pathname);
    if (!path.startsWith(root + sep)) { res.writeHead(403); res.end(); return; }
    const bytes = await readFile(path);
    res.writeHead(200, { 'Content-Type': types[extname(path)] || 'application/octet-stream', 'Cache-Control': 'no-store' }); res.end(bytes);
  } catch (error) { res.writeHead(error.code === 'ENOENT' ? 404 : 500); res.end(error.code === 'ENOENT' ? 'File not found' : error.message); }
}).listen(port, '127.0.0.1', () => console.log(`Cage Lab: http://localhost:${port}`));
