'use strict';
// Servidor local de desenvolvimento: arquivos estáticos + /api/store com Redis falso em memória.
// Uso: node teste/server.js  →  http://localhost:3000   (admin: dono@teste.com)
const http = require('http'), fs = require('fs'), path = require('path');
const fake = require('./fake-redis');
const root = path.join(__dirname, '..');
const hdrs = (require('../vercel.json').headers || [])[0]; // mesmos cabeçalhos de segurança do Vercel
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.gif': 'image/gif', '.png': 'image/png', '.svg': 'image/svg+xml' };
(async () => {
  await fake.start(6399, 'dev');
  Object.assign(process.env, { KV_REST_API_URL: 'http://127.0.0.1:6399', KV_REST_API_TOKEN: 'dev', SESSION_SECRET: process.env.SESSION_SECRET || 'segredo-local-de-desenvolvimento', ADMIN_EMAIL: process.env.ADMIN_EMAIL || 'dono@teste.com' });
  // PIX simulado: sem credencial real, a cobrança “paga” sozinha depois de 20 s (a página do pedido confirma sozinha).
  Object.assign(process.env, { MISTICPAY_CLIENT_ID: process.env.MISTICPAY_CLIENT_ID || 'pk_dev', MISTICPAY_CLIENT_SECRET: process.env.MISTICPAY_CLIENT_SECRET || 'sk_dev' });
  require('./mp-mock').install({ autoPayMs: 20000 });
  const store = require('../api/store.js');
  http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (hdrs) hdrs.headers.forEach((h) => res.setHeader(h.key, h.value));
    if (u.pathname === '/api/store') {
      let raw = ''; req.on('data', (c) => { raw += c; });
      req.on('end', () => { try { req.body = raw ? JSON.parse(raw) : {}; } catch (_) { req.body = {}; } req.headers['x-forwarded-proto'] = 'http'; store(req, res); });
      return;
    }
    let f = path.join(root, u.pathname === '/' ? 'index.html' : decodeURIComponent(u.pathname));
    if (!f.startsWith(root) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.statusCode = 404; return res.end('404'); }
    res.setHeader('Content-Type', types[path.extname(f)] || 'application/octet-stream'); fs.createReadStream(f).pipe(res);
  }).listen(process.env.PORT || 3000, () => console.log('Loja em http://localhost:' + (process.env.PORT || 3000)));
})();
