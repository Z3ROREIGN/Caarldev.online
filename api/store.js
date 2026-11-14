'use strict';
// API única da loja: /api/store?r=<rota>. Uma função só para caber no limite do plano gratuito do Vercel.
const crypto = require('crypto');
const r = require('../lib/redis');
const A = require('../lib/auth');
const S = require('../lib/shop');
const V = require('../lib/reviews');
const T = require('../lib/support');
const B = require('../lib/backup');
const TOTP = require('../lib/totp');
const { resolvePages, DEFAULT_PAGES } = require('../lib/pages');
const { notify } = require('../lib/notify');
const { HttpError, fail, str, int, bool, now, cleanEmail, isEmail, csvCell, url: cleanUrl } = require('../lib/util');

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
    wishBack: c.user ? await V.wlBack(c.user) : 0,       // favoritos que voltaram ao estoque
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
  // Sem verificação de e-mail, quem souber o e-mail do admin poderia criar a conta antes do dono. Com ADMIN_SETUP_KEY, só quem tem a chave consegue.
  if (admin && process.env.ADMIN_SETUP_KEY && !A.same(String(c.body.setupKey || ''), process.env.ADMIN_SETUP_KEY)) fail(403, 'Esse e-mail é do administrador: informe a chave de configuração (ADMIN_SETUP_KEY) para criar a conta.');
  const id = S.newId();
  if ((await r.cmd(['SET', S.K.email(email), id, 'NX'])) === null) fail(409, 'Já existe uma conta com esse e-mail.');
  const user = { id, name, email, role: admin ? 'admin' : 'user', pw: await A.hashPassword(pw), tv: 0, createdAt: now(), lastLogin: now() };
  await S.setJ(S.K.user(id), user);
  await r.cmd(['SADD', S.K.users, id]);
  if (admin) await S.audit(user, 'admin:criado', 'Conta admin criada pelo e-mail configurado');
  A.setSession(c.req, c.res, user);
  return { user: S.publicUser(user) };
});
// Segundo fator: código do app autenticador (uma vez por passo de 30 s) ou um código de recuperação (uso único).
function secondFactor(user, code) {
  const step = TOTP.verify(user.totp, code, user.totpLast || 0);
  if (step) { user.totpLast = step; return true; }
  const h = TOTP.hashCode(code), k = (user.recovery || []).indexOf(h);
  if (k >= 0) { user.recovery.splice(k, 1); return true; }
  return false;
}
R('POST', 'login', 'public', async (c) => {
  const email = cleanEmail(c.body.email), pw = String(c.body.password || '');
  await A.limit(`login:${A.ip(c.req)}:${email}`, 14, 600);
  await A.limit(`loginip:${A.ip(c.req)}`, 50, 600);
  await A.lockCheck(email);
  const id = isEmail(email) ? await r.cmd(['GET', S.K.email(email)]) : null;
  const user = id ? await S.getJ(S.K.user(id)) : null;
  const ok = await A.checkPassword(pw, user ? user.pw : 's1$AAAA$AAAA');
  if (!user || !ok) { await A.lockFail(email); fail(401, 'E-mail ou senha incorretos.'); }
  if (user.banned) fail(403, `Conta banida.${user.banReason ? ' Motivo: ' + user.banReason : ''}`);
  if (user.totp) {
    const code = String(c.body.code || '').trim();
    if (!code) return { needCode: true };                 // senha certa: pede o código antes de abrir a sessão
    if (!secondFactor(user, code)) { await A.lockFail(email); fail(401, 'Código de verificação incorreto.'); }
  }
  await A.lockClear(email);
  if (A.isAdminEmail(email) && user.role !== 'admin') user.role = 'admin';
  user.lastLogin = now();
  await S.setJ(S.K.user(id), user);
  A.setSession(c.req, c.res, user);
  return { user: S.publicUser(user) };
});
R('POST', 'logout', 'public', async (c) => { A.clearSession(c.req, c.res); return { ok: true }; });
// Pedido de orçamento / contato do portfólio. Os campos extras são opcionais.
R('POST', 'contact', 'public', async (c) => {
  await A.limit(`contact:${A.ip(c.req)}`, 5, 3600);
  const b = c.body;
  const m = {
    id: S.newId(), at: now(), status: 'novo', nome: str(b.nome, 80), email: cleanEmail(b.email), tipo: str(b.tipo, 40), mensagem: str(b.mensagem, 3000),
    contato: str(b.contato, 80), prazo: str(b.prazo, 40), orcamento: str(b.orcamento, 40), referencia: cleanUrl(b.referencia),
  };
  if (!m.nome || !isEmail(m.email) || m.mensagem.length < 5) fail(400, 'Preencha nome, e-mail e mensagem.');
  await r.cmd(['LPUSH', S.K.msgs, JSON.stringify(m)]);
  await r.cmd(['LTRIM', S.K.msgs, 0, 299]);
  await notify('contact', { title: `Novo pedido de orçamento: ${m.tipo || 'contato'}`, text: m.mensagem, tone: 'info', fields: [['Nome', m.nome], ['Prazo', m.prazo || '—'], ['Orçamento', m.orcamento || '—'], ['Contato', m.contato || m.email]] });
  return { ok: true };
});
R('GET', 'pages', 'public', async () => resolvePages(await S.getCfg()));
R('GET', 'reviews', 'public', async (c) => V.list(c.q.pid, c.user));
R('GET', 'reviews/recent', 'public', async () => ({ reviews: await V.recent(6) }));

/* ===== Conta e pedidos ===== */
R('POST', 'account', 'user', async (c) => {
  const u = c.user, b = c.body;
  if (b.name !== undefined) { const n = str(b.name, 60); if (n.length < 2) fail(400, 'Informe seu nome.'); u.name = n; }
  if (b.newPassword) {
    await A.limit(`pw:${u.id}`, 8, 900);
    if (!(await A.checkPassword(String(b.currentPassword || ''), u.pw))) fail(403, 'A senha atual está incorreta.');
    if (String(b.newPassword).length < 8) fail(400, 'A nova senha precisa ter pelo menos 8 caracteres.');
    u.pw = await A.hashPassword(String(b.newPassword)); u.tv = (u.tv || 0) + 1;
  }
  await S.setJ(S.K.user(u.id), u);
  A.setSession(c.req, c.res, u);
  return { user: S.publicUser(u) };
});
// Verificação em duas etapas. 1) setup gera a chave; 2) enable confirma com um código e devolve os códigos de recuperação (só aparecem uma vez).
R('POST', 'account/2fa/setup', 'user', async (c) => {
  const u = c.user;
  if (u.totp) fail(409, 'A verificação em duas etapas já está ativada.');
  u.totpPending = TOTP.newSecret();
  await S.setJ(S.K.user(u.id), u);
  return { secret: u.totpPending, uri: TOTP.uri(u.totpPending, u.email, (await S.getCfg()).storeName || 'Loja') };
});
R('POST', 'account/2fa/enable', 'user', async (c) => {
  const u = c.user;
  await A.limit(`2fa:${u.id}`, 10, 900);
  if (!u.totpPending) fail(400, 'Comece pela chave de configuração.');
  const step = TOTP.verify(u.totpPending, c.body.code, 0);
  if (!step) fail(400, 'Código incorreto. Confira a hora do celular e tente o código atual.');
  const rec = TOTP.recoveryCodes();
  u.totp = u.totpPending; delete u.totpPending; u.totpLast = step; u.recovery = rec.hashes; u.tv = (u.tv || 0) + 1;
  await S.setJ(S.K.user(u.id), u);
  A.setSession(c.req, c.res, u);
  if (A.isStaff(u)) await S.audit(u, '2fa:ativado', u.email);
  return { codes: rec.codes, user: S.publicUser(u) };
});
R('POST', 'account/2fa/disable', 'user', async (c) => {
  const u = c.user;
  await A.limit(`2fa:${u.id}`, 10, 900);
  if (!u.totp) fail(409, 'A verificação em duas etapas não está ativada.');
  if (!(await A.checkPassword(String(c.body.password || ''), u.pw))) fail(403, 'Senha incorreta.');
  if (!secondFactor(u, String(c.body.code || '').trim())) fail(403, 'Código de verificação incorreto.');
  delete u.totp; delete u.totpLast; delete u.recovery; delete u.totpPending; u.tv = (u.tv || 0) + 1;
  await S.setJ(S.K.user(u.id), u);
  A.setSession(c.req, c.res, u);
  if (A.isStaff(u)) await S.audit(u, '2fa:desativado', u.email);
  return { user: S.publicUser(u) };
});

R('GET', 'orders', 'user', async (c) => {
  const [cfg, ids] = await Promise.all([S.getCfg(), r.cmd(['LRANGE', S.K.userOrd(c.user.id), 0, 99])]);
  return { orders: (await S.mgetOrders(ids)).map((o) => S.userOrder(o, cfg)) };
});
R('GET', 'order', 'user', async (c) => {
  let o = await S.getOrder(c.q.id);
  if (o.userId !== c.user.id && c.user.role !== 'admin') fail(404, 'Pedido não encontrado.');
  o = await S.refreshPayment(o);       // se o webhook atrasar, a própria página confirma o PIX
  return { order: S.userOrder(o, await S.getCfg()) };
});
// Itens do carrinho: [{ productId, qty }]. Também aceita o formato antigo (productId + qty).
const itemsOf = (b) => (Array.isArray(b.items) ? b.items : [{ productId: b.productId, qty: b.qty }]);
R('POST', 'coupon/check', 'user', async (c) => {
  const lines = await S.buildLines(itemsOf(c.body));
  const subtotal = lines.reduce((s, l) => s + l.unit * l.qty, 0);
  const cp = await S.checkCoupon(c.body.coupon, lines, c.user);
  return { discount: cp ? cp.discount : 0, subtotal, total: Math.max(0, subtotal - (cp ? cp.discount : 0)) };
});
R('POST', 'order', 'user', async (c) => {
  const cfg = await S.getCfg();
  if (cfg.maintenance && c.user.role !== 'admin') fail(503, 'A loja está em manutenção. Volte em instantes.');
  await A.limit(`order:${c.user.id}`, 12, 3600);
  const o = await S.createOrder(c.user, { ...c.body, items: itemsOf(c.body) }, { webhookUrl: webhookUrl(c.req) });
  return { order: S.userOrder(o, cfg) };
});
R('POST', 'order/cancel', 'user', async (c) => {
  const o = await S.getOrder(c.body.id);
  if (o.userId !== c.user.id) fail(404, 'Pedido não encontrado.');
  await S.closeOpen(o, c.user, 'cancelado', 'Cancelado pelo cliente');
  return { order: S.userOrder(o, await S.getCfg()) };
});
// Download de arquivos (produtos por link): confere dono, prazo e limite e só então redireciona. O link real nunca vai no JSON do pedido.
R('GET', 'download', 'user', async (c) => {
  const id = str(c.q.id, 40);
  try {
    const o = await S.getOrder(id);
    if (o.userId !== c.user.id) fail(404, 'Pedido não encontrado.');
    return { redirect: await S.downloadUrl(o, int(c.q.line, 0, 0, o.lines.length - 1)) };
  } catch (e) {
    if (e instanceof HttpError) return { redirect: `/#/pedido/${encodeURIComponent(id)}?erro=${encodeURIComponent(e.message)}` };
    throw e;
  }
});

/* ===== Avaliações, favoritos e suporte ===== */
R('POST', 'review/save', 'user', async (c) => { await A.limit(`rv:${c.user.id}`, 10, 3600); await V.save(c.user, c.body); return V.list(c.body.pid, c.user); });
R('POST', 'review/delete', 'user', async (c) => { await V.remove(c.body.pid, c.user.id); return V.list(c.body.pid, c.user); });
R('GET', 'wishlist', 'user', async (c) => ({ products: await V.wlList(c.user), ids: await V.wlIds(c.user) }));
R('POST', 'wishlist/toggle', 'user', async (c) => { await A.limit(`wl:${c.user.id}`, 60, 600); return V.wlToggle(c.user, c.body.pid, bool(c.body.on)); });

R('GET', 'tickets', 'user', async (c) => ({ tickets: await T.listUser(c.user.id) }));
R('GET', 'ticket', 'user', async (c) => {
  const t = await T.getTicket(c.q.id);
  if (t.userId !== c.user.id) fail(404, 'Ticket não encontrado.');
  return { ticket: t };
});
R('POST', 'ticket/new', 'user', async (c) => { await A.limit(`tk:${c.user.id}`, 6, 3600); return { ticket: await T.create(c.user, c.body) }; });
R('POST', 'ticket/reply', 'user', async (c) => { await A.limit(`tkr:${c.user.id}`, 30, 3600); return { ticket: await T.reply(c.user, c.body.id, c.body.text, false) }; });
R('POST', 'ticket/close', 'user', async (c) => {
  const t = await T.getTicket(c.body.id);
  if (t.userId !== c.user.id) fail(404, 'Ticket não encontrado.');
  return { ticket: await T.setStatus(t.id, 'fechado', c.user) };
});

/* ===== Admin e equipe ===== */
// Níveis: "admin" (só admin) ou "perm:a,b" (admin ou equipe com alguma dessas permissões).
R('GET', 'admin/status', 'perm:pedidos,tickets,mensagens,estoque,produtos,cupons,portfolio,avaliacoes', async (c) => {
  let session = true; try { A.secret(); } catch (_) { session = false; }
  const cfg = c.user.role === 'admin' ? await S.getCfg() : null;
  return { redis: true, session, adminEmails: A.adminEmails().length, misticpay: require('../lib/misticpay').configured(), setupKey: !!process.env.ADMIN_SETUP_KEY, discord: cfg ? !!require('../lib/notify').hookUrl(cfg) : null, twofa: !!c.user.totp };
});
R('GET', 'admin/stats', 'admin', async () => { await S.sweepExpired(true); return { ...(await S.stats()), tickets: await T.openCount() }; });
R('GET', 'admin/report', 'admin', async (c) => S.report(c.q.range));
R('GET', 'admin/orders', 'perm:pedidos', async (c) => ({ orders: await S.listOrders({ status: c.q.status, q: str(c.q.q, 60), from: c.q.from, to: c.q.to }) }));
R('POST', 'admin/order', 'perm:pedidos', async (c) => {
  const o = await S.getOrder(c.body.id), a = c.body.action, by = c.user;
  if (['pay', 'cancel', 'refund'].includes(a) && by.role !== 'admin') fail(403, 'Só administradores podem confirmar pagamento, cancelar ou reembolsar.');
  const pick = () => (c.body.line !== undefined && c.body.line !== '' ? int(c.body.line, 0, 0, o.lines.length - 1) : Math.max(0, o.lines.findIndex((l) => l.mode === 'manual' && !l.delivered)));
  if (a === 'pay') await S.markPaid(o, by);
  else if (a === 'deliver') {
    if (!['pago', 'entregue'].includes(o.status)) fail(409, 'Confirme o pagamento antes de entregar.');
    const i = pick(), text = str(c.body.text, 4000);
    if (o.lines[i].mode !== 'manual') fail(400, 'Essa linha é entregue automaticamente.');
    if (!text) fail(400, 'Escreva o que será entregue ao cliente.');
    S.setDelivered(o, i, { type: 'manual', text }); S.syncStatus(o);
    S.hist(o, by, `Entrega registrada${o.lines.length > 1 ? ` (${o.lines[i].name})` : ''}`); await S.saveOrder(o);
  } else if (a === 'resetdl') {
    const l = o.lines[pick()];
    if (!l || !l.delivered || l.delivered.type !== 'link') fail(400, 'Essa linha não é um download.');
    l.delivered.downloads = 0; l.delivered.resetAt = now(); S.hist(o, by, `Download renovado (${l.name})`); await S.saveOrder(o);
  } else if (a === 'cancel') await S.closeOpen(o, by, 'cancelado', 'Cancelado pelo admin');
  else if (a === 'refund') await S.refund(o, by, bool(c.body.restock));
  else if (a === 'note') { o.adminNote = str(c.body.text, 500); S.hist(o, by, 'Nota interna atualizada'); await S.saveOrder(o); }
  else fail(400, 'Ação desconhecida.');
  await S.audit(by, `pedido:${a}`, o.code);
  return { order: S.adminOrder(o) };
});
const money = (v) => (v / 100).toFixed(2).replace('.', ',');
const brt = (t) => (t ? new Date(t - 3 * 3600e3).toISOString().slice(0, 16).replace('T', ' ') : '');
const csv = (name, head, rows) => ({ raw: '\ufeff' + [head.join(';'), ...rows.map((r2) => r2.map(csvCell).join(';'))].join('\n'), type: 'text/csv; charset=utf-8', name });
R('GET', 'admin/export', 'admin', async (c) => {
  const rows = await S.listOrders({ status: c.q.status, q: str(c.q.q, 60), from: c.q.from, to: c.q.to, limit: 2000 });
  return csv('pedidos.csv', ['Pedido', 'Data', 'Status', 'Cliente', 'E-mail', 'Produtos', 'Itens', 'Subtotal', 'Desconto', 'Total', 'Cupom', 'Contato'],
    rows.map((o) => [o.code, brt(o.createdAt), o.status, o.userName, o.userEmail, o.lines.map((l) => `${l.qty}x ${l.name}`).join(' + '), o.lines.reduce((s, l) => s + l.qty, 0), money(o.subtotal), money(o.discount), money(o.total), o.coupon || '', o.contact]));
});
R('GET', 'admin/export/users', 'admin', async () => csv('usuarios.csv', ['Nome', 'E-mail', 'Cargo', 'Banido', 'Motivo do ban', '2FA', 'Pedidos', 'Cadastro', 'Último acesso'],
  (await S.listUsers()).map((u) => [u.name, u.email, u.role, u.banned ? 'sim' : 'não', u.banReason, u.twofa ? 'sim' : 'não', u.orders, brt(u.createdAt), brt(u.lastLogin)])));
R('GET', 'admin/export/logs', 'admin', async () => csv('registros.csv', ['Quando', 'Quem', 'Ação', 'Detalhe'],
  (await r.cmd(['LRANGE', S.K.log, 0, 499])).map((x) => { try { return JSON.parse(x); } catch (_) { return null; } }).filter(Boolean).map((l) => [brt(l.at), l.by, l.action, l.detail])));

R('GET', 'admin/products', 'perm:produtos,estoque', async () => ({ products: await S.listProducts({ admin: true }), categories: await S.getCats() }));
R('POST', 'admin/product/save', 'perm:produtos', async (c) => { const p = await S.saveProduct(c.body); await S.audit(c.user, c.body.id ? 'produto:editado' : 'produto:criado', p.name); return { product: p }; });
R('POST', 'admin/product/toggle', 'perm:produtos', async (c) => {
  const p = await S.getJ(S.K.prod(str(c.body.id, 40))) || fail(404, 'Produto não encontrado.');
  const f = c.body.field === 'featured' ? 'featured' : 'active';
  p[f] = !p[f]; await S.setJ(S.K.prod(p.id), p);
  await S.audit(c.user, `produto:${f}`, `${p.name} → ${p[f] ? 'sim' : 'não'}`);
  return { product: p };
});
R('POST', 'admin/product/duplicate', 'perm:produtos', async (c) => { const p = await S.duplicateProduct(c.body.id); await S.audit(c.user, 'produto:duplicado', p.name); return { product: p }; });
R('POST', 'admin/product/bulk', 'perm:produtos', async (c) => { const out = await S.bulkProducts(c.body.ids, c.body.action, c.body); await S.audit(c.user, `produto:massa:${c.body.action}`, `${out.changed} produto(s)`); return out; });
R('POST', 'admin/product/delete', 'perm:produtos', async (c) => {
  const p = await S.getJ(S.K.prod(str(c.body.id, 40))) || fail(404, 'Produto não encontrado.');
  await S.deleteProduct(p.id); await S.audit(c.user, 'produto:apagado', p.name); return { ok: true };
});
R('GET', 'admin/stock', 'perm:estoque,produtos', async (c) => await S.stockInfo(str(c.q.id, 40)));
R('POST', 'admin/stock', 'perm:estoque,produtos', async (c) => {
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
  else if (a === 'promote') { u.role = 'admin'; delete u.perms; }
  else if (a === 'staff') {      // equipe: só o que o admin liberar
    if (locked) fail(403, 'Você não pode mudar o cargo dessa conta.');
    u.role = 'staff'; u.perms = (Array.isArray(c.body.perms) ? c.body.perms : []).filter((p) => A.PERMS.includes(p));
    if (!u.perms.length) fail(400, 'Marque pelo menos uma permissão.');
  }
  else if (a === 'demote') { if (locked) fail(403, 'Você não pode remover o cargo desse admin.'); u.role = 'user'; delete u.perms; }
  else if (a === 'resetpw') { const tmp = crypto.randomBytes(9).toString('base64url'); u.pw = await A.hashPassword(tmp); u.tv = (u.tv || 0) + 1; extra = { tempPassword: tmp }; }
  else if (a === 'reset2fa') { delete u.totp; delete u.totpLast; delete u.recovery; delete u.totpPending; u.tv = (u.tv || 0) + 1; }
  else if (a === 'delete') {
    if (locked) fail(403, 'Você não pode apagar essa conta.');
    await r.cmd(['DEL', S.K.user(u.id), S.K.email(u.email)]); await r.cmd(['SREM', S.K.users, u.id]);
    await S.audit(c.user, 'usuario:apagado', u.email); return { ok: true };
  } else fail(400, 'Ação desconhecida.');
  await S.setJ(S.K.user(u.id), u);
  await S.audit(c.user, `usuario:${a}`, u.email);
  return { ok: true, ...extra };
});

R('GET', 'admin/coupons', 'perm:cupons', async () => ({ coupons: await S.listCoupons() }));
R('POST', 'admin/coupon/save', 'perm:cupons', async (c) => { const x = await S.saveCoupon(c.body); await S.audit(c.user, 'cupom:salvo', x.code); return { coupon: x }; });
R('POST', 'admin/coupon/payout', 'perm:cupons', async (c) => { const x = await S.couponPayout(c.body.code, c.body.amount); await S.audit(c.user, 'cupom:comissao-paga', `${x.code} ${money(int(c.body.amount, 0))}`); return { coupon: x }; });
R('POST', 'admin/coupon/delete', 'perm:cupons', async (c) => {
  const code = str(c.body.code, 30).toUpperCase();
  await r.cmd(['DEL', S.K.coupon(code), S.K.couponUse(code), S.K.couponPaidN(code), S.K.couponRev(code)]); await r.cmd(['SREM', S.K.coupons, code]);
  await S.audit(c.user, 'cupom:apagado', code); return { ok: true };
});

R('POST', 'admin/portfolio/save', 'perm:portfolio', async (c) => { const items = await S.savePortfolio(c.body.items); await S.audit(c.user, 'portfolio:salvo', `${items.length} itens`); return { items }; });
R('GET', 'admin/settings', 'admin', async () => ({ config: await S.getCfg() }));
R('POST', 'admin/settings/save', 'admin', async (c) => { const cfg = await S.saveCfg(c.body); await S.audit(c.user, 'config:salva', ''); return { config: cfg }; });
R('GET', 'admin/pages', 'admin', async () => ({ pages: (await S.getCfg()).pages, defaults: { ...DEFAULT_PAGES, faq: DEFAULT_PAGES.faq.map(([q, a]) => ({ q, a })) } }));
R('POST', 'admin/pages/save', 'admin', async (c) => { await S.savePages(c.body); await S.audit(c.user, 'paginas:salvas', ''); return { ok: true }; });
R('POST', 'admin/discord/test', 'admin', async (c) => {
  const ok = await notify('test', { title: 'Teste de aviso', text: 'Se você está lendo isto no Discord, os avisos da loja estão funcionando.', tone: 'ok' });
  if (!ok) fail(400, 'Não consegui enviar. Confira se o endereço do webhook (ou DISCORD_WEBHOOK_URL) está correto e salvo.');
  return { ok: true };
});
R('GET', 'admin/logs', 'admin', async () => ({ logs: (await r.cmd(['LRANGE', S.K.log, 0, 199])).map((x) => { try { return JSON.parse(x); } catch (_) { return null; } }).filter(Boolean) }));

const readMsgs = async () => (await r.cmd(['LRANGE', S.K.msgs, 0, 299])).map((x) => { try { return JSON.parse(x); } catch (_) { return null; } });
R('GET', 'admin/messages', 'perm:mensagens', async () => ({ messages: (await readMsgs()).filter(Boolean).slice(0, 200) }));
R('POST', 'admin/message/status', 'perm:mensagens', async (c) => {
  const all = await readMsgs(), i = all.findIndex((m) => m && m.id === c.body.id);
  if (i < 0) fail(404, 'Mensagem não encontrada.');
  all[i].status = ['novo', 'conversando', 'fechado'].includes(c.body.status) ? c.body.status : 'novo';
  await r.cmd(['LSET', S.K.msgs, i, JSON.stringify(all[i])]);
  return { ok: true };
});
R('POST', 'admin/message/delete', 'perm:mensagens', async (c) => {
  const raw = (await r.cmd(['LRANGE', S.K.msgs, 0, 299])).find((x) => { try { return JSON.parse(x).id === c.body.id; } catch (_) { return false; } });
  if (raw) await r.cmd(['LREM', S.K.msgs, 1, raw]);
  return { ok: true };
});

R('GET', 'admin/tickets', 'perm:tickets', async (c) => ({ tickets: await T.listAdmin({ status: c.q.status, q: str(c.q.q, 60) }) }));
R('GET', 'admin/ticket', 'perm:tickets', async (c) => {
  const t = await T.getTicket(c.q.id);
  const order = t.orderId ? await S.getOrder(t.orderId).catch(() => null) : null;
  return { ticket: t, order: order ? S.adminOrder(order) : null };
});
R('POST', 'admin/ticket/reply', 'perm:tickets', async (c) => { const t = await T.reply(c.user, c.body.id, c.body.text, true); await S.audit(c.user, 'ticket:resposta', t.code); return { ticket: t }; });
R('POST', 'admin/ticket/status', 'perm:tickets', async (c) => { const t = await T.setStatus(c.body.id, c.body.status, c.user); await S.audit(c.user, `ticket:${c.body.status}`, t.code); return { ticket: t }; });
R('POST', 'admin/ticket/approve', 'perm:tickets', async (c) => { const t = await T.approveReplace(c.body.id, c.user); await S.audit(c.user, 'ticket:reposicao-aprovada', t.code); return { ticket: t }; });
R('POST', 'admin/ticket/deny', 'perm:tickets', async (c) => { const t = await T.deny(c.body.id, c.user, c.body.text); await S.audit(c.user, 'ticket:reposicao-negada', t.code); return { ticket: t }; });

R('GET', 'admin/reviews', 'perm:avaliacoes', async () => ({ reviews: await V.adminList() }));
R('POST', 'admin/review', 'perm:avaliacoes', async (c) => {
  const a = c.body.action;
  if (a === 'delete') await V.remove(c.body.pid, c.body.uid);
  else if (a === 'hide' || a === 'show') await V.moderate(c.body.pid, c.body.uid, { hidden: a === 'hide' });
  else if (a === 'reply') await V.moderate(c.body.pid, c.body.uid, { reply: c.body.text });
  else fail(400, 'Ação desconhecida.');
  await S.audit(c.user, `avaliacao:${a}`, str(c.body.pid, 40));
  return { ok: true };
});

// Backup completo (inclui senhas criptografadas e chaves de 2FA: guarde em lugar seguro). Pede a senha do admin.
const needPassword = async (c) => {
  await A.limit(`bk:${c.user.id}`, 6, 900);
  if (!(await A.checkPassword(String(c.body.password || ''), c.user.pw))) fail(403, 'Senha incorreta.');
};
R('POST', 'admin/backup', 'admin', async (c) => {
  await needPassword(c);
  const data = await B.dump();
  await S.audit(c.user, 'backup:exportado', `${data.count} chaves`);
  return { raw: JSON.stringify(data), type: 'application/json; charset=utf-8', name: `backup-loja-${new Date().toISOString().slice(0, 10)}.json` };
});
R('POST', 'admin/restore', 'admin', async (c) => {
  await needPassword(c);
  if (c.body.confirm !== 'RESTAURAR') fail(400, 'Digite RESTAURAR para confirmar.');
  const out = await B.restore(c.body.data);
  await S.audit(c.user, 'backup:restaurado', `${out.restored} chaves`);
  return out;
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
      if (route.level.startsWith('perm:') && !A.canAny(c.user, route.level.slice(5).split(','))) fail(403, 'Você não tem permissão para isso.');
    }
    const out = await route.fn(c);
    if (out && out.redirect) { res.statusCode = 302; res.setHeader('Location', out.redirect); return res.end(); }
    if (out && out.raw !== undefined) {
      res.statusCode = 200; res.setHeader('Content-Type', out.type);
      res.setHeader('Content-Disposition', `attachment; filename="${out.name}"`);
      return res.end(out.raw);
    }
    return send(200, out || { ok: true });
  } catch (e) {
    if (e instanceof HttpError) return send(e.status, { error: e.message, ...(e.extra || {}) });
    if (e && e.setup) return send(503, { error: `Configuração incompleta: ${e.message}`, setup: true });
    const msg = String((e && e.message) || e);
    console.error('[store]', msg);
    if (/Redis/.test(msg)) return send(503, { error: msg.includes('não conectado') ? 'Banco Redis não conectado ao projeto no Vercel.' : 'Banco de dados indisponível. Tente de novo.', setup: msg.includes('não conectado') });
    return send(500, { error: 'Erro interno. Tente de novo.' });
  }
};
