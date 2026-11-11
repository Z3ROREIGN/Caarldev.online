'use strict';
// API única da loja: /api/store?r=<rota>. Uma função só para caber no limite do plano gratuito do Vercel.
const crypto = require('crypto');
const r = require('../lib/redis');
const A = require('../lib/auth');
const S = require('../lib/shop');
const { HttpError, fail, str, int, bool, now, cleanEmail, isEmail, csvCell } = require('../lib/util');

const routes = {};
const R = (method, name, level, fn) => { routes[`${method} ${name}`] = { level, fn }; };

// Endereço do site, usado para dizer à MisticPay onde avisar o pagamento (/api/webhook).
function webhookUrl(req) {
  let base = process.env.SITE_URL || (process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : '');
  if (!base) {
    const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
    if (!/^[a-z0-9.-]+(:\d+)?$/i.test(host) || /^(localhost|127\.|0\.0\.0\.0)/i.test(host)) return '';   // local: sem webhook (a página confirma sozinha)
    base = `${String(req.headers['x-forwarded-proto'] || 'https').split(',')[0]}://${host}`;
  }
  base = base.replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(base)) base = 'https://' + base;
  return /^https:\/\//i.test(base) ? `${base}/api/webhook` : '';
}

async function loadUser(c) {
  const s = A.readSession(A.tokenOf(c.req));
  if (!s) return;
  const u = await S.getJ(S.K.user(s.u));
  if (!u) return;
  if (u.banned) { c.banned = u; return; }          // banido: derruba a sessão na hora
  if ((u.tv || 0) !== s.tv) return;
  c.user = u;
}
const needUser = (c) => c.user || fail(401, 'Entre na sua conta para continuar.');

/* ===== Público ===== */
R('GET', 'bootstrap', 'public', async (c) => {
  await S.sweepExpired();
  const [cfg, cats] = await Promise.all([S.getCfg(), S.getCats()]);
  return {
    user: S.publicUser(c.user), banned: c.banned ? { reason: c.banned.banReason || '' } : null,
    config: S.publicCfg(cfg), categories: cats.filter((x) => x.active),
  };
});
R('GET', 'products', 'public', async (c) => {
  const cfg = await S.getCfg();
  const admin = c.user && c.user.role === 'admin';
  if (cfg.maintenance && !admin) return { products: [], maintenance: true };
  await S.sweepExpired();
  const q = c.q;
  let products = await S.listProducts({ section: q.section, cat: q.cat, q: str(q.q, 60), id: q.id });
  if (q.featured) products = products.filter((p) => p.featured);
  return { products };
});
R('GET', 'portfolio', 'public', async () => ({ items: await S.getPortfolio() }));

R('POST', 'register', 'public', async (c) => {
  await A.limit(`reg:${A.ip(c.req)}`, 6, 3600);
  const cfg = await S.getCfg();
  const name = str(c.body.name, 60), email = cleanEmail(c.body.email), pw = String(c.body.password || '');
  if (name.length < 2) fail(400, 'Informe seu nome.');
  if (!isEmail(email)) fail(400, 'Informe um e-mail válido.');
  if (pw.length < 8 || pw.length > 100) fail(400, 'A senha precisa ter de 8 a 100 caracteres.');
  const admin = A.isAdminEmail(email);
  if (!cfg.registrationOpen && !admin) fail(403, 'Os cadastros estão fechados no momento.');
  const id = S.newId();
  if ((await r.cmd(['SET', S.K.email(email), id, 'NX'])) === null) fail(409, 'Já existe uma conta com esse e-mail.');
  const user = { id, name, email, role: admin ? 'admin' : 'user', pw: await A.hashPassword(pw), tv: 0, createdAt: now(), lastLogin: now() };
  await S.setJ(S.K.user(id), user);
  await r.cmd(['SADD', S.K.users, id]);
  if (admin) await S.audit(user, 'admin:criado', 'Conta admin criada pelo e-mail configurado');
  A.setSession(c.req, c.res, user);
  return { user: S.publicUser(user) };
});
R('POST', 'login', 'public', async (c) => {
  const email = cleanEmail(c.body.email), pw = String(c.body.password || '');
  await A.limit(`login:${A.ip(c.req)}:${email}`, 8, 600);
  const id = isEmail(email) ? await r.cmd(['GET', S.K.email(email)]) : null;
  const user = id ? await S.getJ(S.K.user(id)) : null;
  const ok = await A.checkPassword(pw, user ? user.pw : 's1$AAAA$AAAA');
  if (!user || !ok) fail(401, 'E-mail ou senha incorretos.');
  if (user.banned) fail(403, `Conta banida.${user.banReason ? ' Motivo: ' + user.banReason : ''}`);
  if (A.isAdminEmail(email) && user.role !== 'admin') user.role = 'admin';
  user.lastLogin = now();
  await S.setJ(S.K.user(id), user);
  A.setSession(c.req, c.res, user);
  return { user: S.publicUser(user) };
});
R('POST', 'logout', 'public', async (c) => { A.clearSession(c.req, c.res); return { ok: true }; });
R('POST', 'contact', 'public', async (c) => {
  await A.limit(`contact:${A.ip(c.req)}`, 5, 3600);
  const m = { id: S.newId(), at: now(), nome: str(c.body.nome, 80), email: cleanEmail(c.body.email), tipo: str(c.body.tipo, 40), mensagem: str(c.body.mensagem, 3000) };
  if (!m.nome || !isEmail(m.email) || m.mensagem.length < 5) fail(400, 'Preencha nome, e-mail e mensagem.');
  await r.cmd(['LPUSH', S.K.msgs, JSON.stringify(m)]);
  await r.cmd(['LTRIM', S.K.msgs, 0, 299]);
  return { ok: true };
});

/* ===== Conta e pedidos ===== */
R('POST', 'account', 'user', async (c) => {
  const u = c.user, b = c.body;
  if (b.name !== undefined) { const n = str(b.name, 60); if (n.length < 2) fail(400, 'Informe seu nome.'); u.name = n; }
  if (b.newPassword) {
    if (!(await A.checkPassword(String(b.currentPassword || ''), u.pw))) fail(403, 'A senha atual está incorreta.');
    if (String(b.newPassword).length < 8) fail(400, 'A nova senha precisa ter pelo menos 8 caracteres.');
    u.pw = await A.hashPassword(String(b.newPassword)); u.tv = (u.tv || 0) + 1;
  }
  await S.setJ(S.K.user(u.id), u);
  A.setSession(c.req, c.res, u);
  return { user: S.publicUser(u) };
});
R('GET', 'orders', 'user', async (c) => {
  const [cfg, ids] = await Promise.all([S.getCfg(), r.cmd(['LRANGE', S.K.userOrd(c.user.id), 0, 99])]);
  return { orders: (await S.mgetJ(ids.map(S.K.ord))).filter(Boolean).map((o) => S.userOrder(o, cfg)) };
});
R('GET', 'order', 'user', async (c) => {
  let o = await S.getOrder(c.q.id);
  if (o.userId !== c.user.id && c.user.role !== 'admin') fail(404, 'Pedido não encontrado.');
  o = await S.refreshPayment(o);       // se o webhook atrasar, a própria página confirma o PIX
  return { order: S.userOrder(o, await S.getCfg()) };
});
R('POST', 'coupon/check', 'user', async (c) => {
  const p = (await S.listProducts({ id: str(c.body.productId, 40) }))[0] || fail(404, 'Produto indisponível.');
  const qty = int(c.body.qty, 1, 1, p.maxPerOrder), subtotal = p.price * qty;
  const cp = await S.checkCoupon(c.body.coupon, subtotal, p.section);
  return { discount: cp ? cp.discount : 0, total: Math.max(0, subtotal - (cp ? cp.discount : 0)) };
});
R('POST', 'order', 'user', async (c) => {
  const cfg = await S.getCfg();
  if (cfg.maintenance && c.user.role !== 'admin') fail(503, 'A loja está em manutenção. Volte em instantes.');
  await A.limit(`order:${c.user.id}`, 12, 3600);
  const o = await S.createOrder(c.user, c.body, { webhookUrl: webhookUrl(c.req) });
  return { order: S.userOrder(o, cfg) };
});
R('POST', 'order/cancel', 'user', async (c) => {
  const o = await S.getOrder(c.body.id);
  if (o.userId !== c.user.id) fail(404, 'Pedido não encontrado.');
  await S.closeOpen(o, c.user, 'cancelado', 'Cancelado pelo cliente');
  return { order: S.userOrder(o, await S.getCfg()) };
});

/* ===== Admin ===== */
R('GET', 'admin/status', 'admin', async () => {
  let session = true; try { A.secret(); } catch (_) { session = false; }
  return { redis: true, session, adminEmails: A.adminEmails().length, misticpay: require('../lib/misticpay').configured() };
});
R('GET', 'admin/stats', 'admin', async () => { await S.sweepExpired(true); return await S.stats(); });
R('GET', 'admin/orders', 'admin', async (c) => ({ orders: await S.listOrders({ status: c.q.status, q: str(c.q.q, 60) }) }));
R('POST', 'admin/order', 'admin', async (c) => {
  const o = await S.getOrder(c.body.id), a = c.body.action, by = c.user;
  if (a === 'pay') await S.markPaid(o, by);
  else if (a === 'deliver') {
    if (!['pago', 'entregue'].includes(o.status)) fail(409, 'Confirme o pagamento antes de entregar.');
    const text = str(c.body.text, 4000);
    if (!text) fail(400, 'Escreva o que será entregue ao cliente.');
    o.delivery = { type: 'manual', text }; o.status = 'entregue'; o.deliveredAt = now();
    S.hist(o, by, 'Entrega registrada'); await S.saveOrder(o);
  } else if (a === 'cancel') await S.closeOpen(o, by, 'cancelado', 'Cancelado pelo admin');
  else if (a === 'refund') await S.refund(o, by, bool(c.body.restock));
  else if (a === 'note') { o.adminNote = str(c.body.text, 500); S.hist(o, by, 'Nota interna atualizada'); await S.saveOrder(o); }
  else fail(400, 'Ação desconhecida.');
  await S.audit(by, `pedido:${a}`, o.code);
  return { order: S.adminOrder(o) };
});
R('GET', 'admin/export', 'admin', async () => {
  const rows = await S.listOrders({ limit: 2000 });
  const head = ['Pedido', 'Data', 'Status', 'Cliente', 'E-mail', 'Produto', 'Qtd', 'Subtotal', 'Desconto', 'Total', 'Cupom', 'Contato'];
  const money = (v) => (v / 100).toFixed(2).replace('.', ',');
  const lines = rows.map((o) => [o.code, new Date(o.createdAt - 3 * 3600e3).toISOString().slice(0, 16).replace('T', ' '), o.status, o.userName, o.userEmail, o.lines[0].name, o.lines[0].qty, money(o.subtotal), money(o.discount), money(o.total), o.coupon || '', o.contact].map(csvCell).join(';'));
  return { raw: '\ufeff' + [head.join(';'), ...lines].join('\n'), type: 'text/csv; charset=utf-8', name: 'pedidos.csv' };
});

R('GET', 'admin/products', 'admin', async () => ({ products: await S.listProducts({ admin: true }), categories: await S.getCats() }));
R('POST', 'admin/product/save', 'admin', async (c) => { const p = await S.saveProduct(c.body); await S.audit(c.user, c.body.id ? 'produto:editado' : 'produto:criado', p.name); return { product: p }; });
R('POST', 'admin/product/toggle', 'admin', async (c) => {
  const p = await S.getJ(S.K.prod(str(c.body.id, 40))) || fail(404, 'Produto não encontrado.');
  const f = c.body.field === 'featured' ? 'featured' : 'active';
  p[f] = !p[f]; await S.setJ(S.K.prod(p.id), p);
  await S.audit(c.user, `produto:${f}`, `${p.name} → ${p[f] ? 'sim' : 'não'}`);
  return { product: p };
});
R('POST', 'admin/product/delete', 'admin', async (c) => {
  const p = await S.getJ(S.K.prod(str(c.body.id, 40))) || fail(404, 'Produto não encontrado.');
  await S.deleteProduct(p.id); await S.audit(c.user, 'produto:apagado', p.name); return { ok: true };
});
R('GET', 'admin/stock', 'admin', async (c) => await S.stockInfo(str(c.q.id, 40)));
R('POST', 'admin/stock', 'admin', async (c) => {
  const out = await S.stockAction(str(c.body.id, 40), c.body);
  await S.audit(c.user, `estoque:${c.body.action}`, str(c.body.id, 40));
  return out;
});

R('GET', 'admin/categories', 'admin', async () => ({ categories: await S.getCats() }));
R('POST', 'admin/category/save', 'admin', async (c) => { const x = await S.saveCategory(c.body); await S.audit(c.user, 'categoria:salva', x.name); return { category: x }; });
R('POST', 'admin/category/delete', 'admin', async (c) => { await S.deleteCategory(str(c.body.id, 40), str(c.body.moveTo, 40)); await S.audit(c.user, 'categoria:apagada', c.body.id); return { ok: true }; });

R('GET', 'admin/users', 'admin', async (c) => ({ users: await S.listUsers(str(c.q.q, 60)) }));
R('POST', 'admin/user', 'admin', async (c) => {
  const u = await S.getJ(S.K.user(str(c.body.id, 40))) || fail(404, 'Usuário não encontrado.');
  const a = c.body.action, locked = u.id === c.user.id || A.isAdminEmail(u.email);
  let extra = {};
  if (a === 'ban') {
    if (locked || u.role === 'admin') fail(403, 'Admins não podem ser banidos. Remova o cargo de admin primeiro.');
    u.banned = true; u.banReason = str(c.body.reason, 200) || 'Violação das regras'; u.tv = (u.tv || 0) + 1;
  } else if (a === 'unban') { u.banned = false; u.banReason = ''; }
  else if (a === 'promote') u.role = 'admin';
  else if (a === 'demote') { if (locked) fail(403, 'Você não pode remover o cargo desse admin.'); u.role = 'user'; }
  else if (a === 'resetpw') { const tmp = crypto.randomBytes(9).toString('base64url'); u.pw = await A.hashPassword(tmp); u.tv = (u.tv || 0) + 1; extra = { tempPassword: tmp }; }
  else if (a === 'delete') {
    if (locked) fail(403, 'Você não pode apagar essa conta.');
    await r.cmd(['DEL', S.K.user(u.id), S.K.email(u.email)]); await r.cmd(['SREM', S.K.users, u.id]);
    await S.audit(c.user, 'usuario:apagado', u.email); return { ok: true };
  } else fail(400, 'Ação desconhecida.');
  await S.setJ(S.K.user(u.id), u);
  await S.audit(c.user, `usuario:${a}`, u.email);
  return { ok: true, ...extra };
});

R('GET', 'admin/coupons', 'admin', async () => ({ coupons: await S.listCoupons() }));
R('POST', 'admin/coupon/save', 'admin', async (c) => { const x = await S.saveCoupon(c.body); await S.audit(c.user, 'cupom:salvo', x.code); return { coupon: x }; });
R('POST', 'admin/coupon/delete', 'admin', async (c) => {
  const code = str(c.body.code, 30).toUpperCase();
  await r.cmd(['DEL', S.K.coupon(code), S.K.couponUse(code)]); await r.cmd(['SREM', S.K.coupons, code]);
  await S.audit(c.user, 'cupom:apagado', code); return { ok: true };
});

R('POST', 'admin/portfolio/save', 'admin', async (c) => { const items = await S.savePortfolio(c.body.items); await S.audit(c.user, 'portfolio:salvo', `${items.length} itens`); return { items }; });
R('GET', 'admin/settings', 'admin', async () => ({ config: await S.getCfg() }));
R('POST', 'admin/settings/save', 'admin', async (c) => { const cfg = await S.saveCfg(c.body); await S.audit(c.user, 'config:salva', ''); return { config: cfg }; });
R('GET', 'admin/logs', 'admin', async () => ({ logs: (await r.cmd(['LRANGE', S.K.log, 0, 199])).map((x) => { try { return JSON.parse(x); } catch (_) { return null; } }).filter(Boolean) }));
R('GET', 'admin/messages', 'admin', async () => ({ messages: (await r.cmd(['LRANGE', S.K.msgs, 0, 199])).map((x) => { try { return JSON.parse(x); } catch (_) { return null; } }).filter(Boolean) }));
R('POST', 'admin/message/delete', 'admin', async (c) => {
  const raw = (await r.cmd(['LRANGE', S.K.msgs, 0, 299])).find((x) => { try { return JSON.parse(x).id === c.body.id; } catch (_) { return false; } });
  if (raw) await r.cmd(['LREM', S.K.msgs, 1, raw]);
  return { ok: true };
});

/* ===== Despachante ===== */
function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') { try { return JSON.parse(req.body); } catch (_) { return {}; } }
  return {};
}
module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  const send = (code, obj) => { res.statusCode = code; res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.end(JSON.stringify(obj)); };
  try {
    const u = new URL(req.url, 'http://x');
    const q = Object.fromEntries(u.searchParams);
    const route = routes[`${req.method} ${q.r}`];
    if (!route) return send(route === undefined && ['GET', 'POST'].includes(req.method) ? 404 : 405, { error: 'Rota não encontrada.' });
    if (req.method !== 'GET' && req.headers['x-requested-with'] !== 'cd') fail(403, 'Requisição não permitida.');
    const c = { req, res, q, body: req.method === 'POST' ? readBody(req) : {} };
    if (route.level !== 'public' || req.headers.cookie) await loadUser(c);
    if (route.level !== 'public') {
      if (c.banned) fail(403, `Conta banida.${c.banned.banReason ? ' Motivo: ' + c.banned.banReason : ''}`);
      needUser(c);
      if (route.level === 'admin' && c.user.role !== 'admin') fail(403, 'Acesso restrito a administradores.');
    }
    const out = await route.fn(c);
    if (out && out.raw !== undefined) {
      res.statusCode = 200; res.setHeader('Content-Type', out.type);
      res.setHeader('Content-Disposition', `attachment; filename="${out.name}"`);
      return res.end(out.raw);
    }
    return send(200, out || { ok: true });
  } catch (e) {
    if (e instanceof HttpError) return send(e.status, { error: e.message });
    if (e && e.setup) return send(503, { error: `Configuração incompleta: ${e.message}`, setup: true });
    const msg = String((e && e.message) || e);
    console.error('[store]', msg);
    if (/Redis/.test(msg)) return send(503, { error: msg.includes('não conectado') ? 'Banco Redis não conectado ao projeto no Vercel.' : 'Banco de dados indisponível. Tente de novo.', setup: msg.includes('não conectado') });
    return send(500, { error: 'Erro interno. Tente de novo.' });
  }
};
