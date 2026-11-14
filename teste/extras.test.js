'use strict';
// Recursos novos da loja (carrinho, garantia, avaliações, tickets, 2FA, equipe, cupons, relatórios, backup...). Sem rede: node --test teste/extras.test.js
const test = require('node:test');
const assert = require('node:assert');
const fake = require('./fake-redis');
const TOTP = require('../lib/totp');
const CPF = '52998224725';

let srv, call, cookie = {}, ids = {}, hooks = [], n = 0;
const ok = (r, s = 200) => { assert.strictEqual(r.status, s, JSON.stringify(r.body)); return r.body; };
const admin = (route, body, q) => call('adm', body ? 'POST' : 'GET', route, body, q);
async function mk(name) {   // cria um cliente (um IP diferente por cliente, por causa dos limites)
  ids[name] = n++;
  const r = await call(name, 'POST', 'register', { name: `Cliente ${name}`, email: `${name}@teste.com`, password: 'senha-forte-2' });
  return ok(r).user;
}
const buy = (who, items, extra = {}) => call(who, 'POST', 'order', { terms: true, cpf: CPF, items, ...extra });
const stock = async (pid) => (await call('anon', 'GET', 'products', null, '&id=' + pid)).body.products[0].stock;
const getOrder = async (who, id) => ok(await call(who, 'GET', 'order', null, '&id=' + id)).order;

test.before(async () => {
  srv = await fake.start(6396, 'ex');
  Object.assign(process.env, { KV_REST_API_URL: 'http://127.0.0.1:6396', KV_REST_API_TOKEN: 'ex', SESSION_SECRET: 'segredo-de-teste-1234567890', ADMIN_EMAIL: 'dono@teste.com', MISTICPAY_CLIENT_ID: 'pk', MISTICPAY_CLIENT_SECRET: 'sk' });
  require('./mp-mock').install();
  const real = global.fetch;
  global.fetch = async (u, o) => { if (String(u).includes('discord.com/api/webhooks')) { hooks.push(JSON.parse(o.body)); return { ok: true, status: 204 }; } return real(u, o); };
  const handler = require('../api/store.js');
  call = (who, method, route, body, q = '') => new Promise((resolve) => {
    const req = { method, url: `/api/store?r=${route}${q}`, headers: { 'x-requested-with': 'cd', 'x-forwarded-for': `7.7.${ids[who] || 0}.${who.length}`, cookie: cookie[who] || '' }, body };
    const res = { statusCode: 200, h: {}, setHeader(k, v) { this.h[k.toLowerCase()] = v; }, end(t) {
      if (this.h['set-cookie']) cookie[who] = this.h['set-cookie'].split(';')[0];
      let j; try { j = JSON.parse(t); } catch (_) { j = t; } resolve({ status: this.statusCode, body: j, h: this.h });
    } };
    handler(req, res);
  });
  ids.adm = 90;
  ok(await call('adm', 'POST', 'register', { name: 'Dono', email: 'dono@teste.com', password: 'senha-forte-1' }));
});
test.after(() => srv && srv.server.close());

let A, B, C, cats;   // produtos: A = itens em estoque, B = link ilimitado, C = manual com 7 dias de garantia
test('carrinho com vários produtos: reserva, desconto por seção, entrega mista e rollback', async () => {
  cats = ok(await call('anon', 'GET', 'bootstrap')).categories;
  const cat = (nome) => cats.find((c) => c.name === nome).id;
  A = ok(await admin('admin/product/save', { name: 'Conta Discord', categoryId: cat('Contas'), price: 1000, delivery: 'items', warrantyDays: 3 })).product;
  B = ok(await admin('admin/product/save', { name: 'Mapa', categoryId: cat('Arquivos Rbxl'), price: 3000, delivery: 'link', link: 'https://exemplo.com/m.rbxl', unlimited: true,
    gallery: 'https://i.exemplo.com/1.png\nhttps://i.exemplo.com/2.png\njavascript:x', video: 'https://youtu.be/dQw4w9WgXcQ', includes: 'Scripts\nGUIs\n' })).product;
  C = ok(await admin('admin/product/save', { name: 'Impulso', categoryId: cat('Impulsos (Boosts)'), price: 2000, delivery: 'manual', qty: 3, warrantyDays: 7 })).product;
  assert.deepStrictEqual(B.gallery, ['https://i.exemplo.com/1.png', 'https://i.exemplo.com/2.png']);   // javascript: é descartado
  assert.strictEqual(B.video, 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ');
  assert.deepStrictEqual(B.includes, ['Scripts', 'GUIs']);
  ok(await admin('admin/stock', { id: A.id, action: 'add', lines: 'a1\na2\na3\na4' }));
  await mk('ana');

  // sem aceitar os termos não compra
  assert.strictEqual((await call('ana', 'POST', 'order', { cpf: CPF, items: [{ productId: A.id, qty: 1 }] })).status, 400);
  // falha no meio do carrinho devolve o que já tinha reservado (C reservou e A não tem 10)
  assert.strictEqual((await buy('ana', [{ productId: C.id, qty: 1 }, { productId: A.id, qty: 10 }])).status, 409);
  assert.strictEqual((await stock(C.id)).count, 3);
  assert.strictEqual((await stock(A.id)).count, 4);

  // cupom de uma seção só desconta os itens dessa seção
  ok(await admin('admin/coupon/save', { code: 'DISC20', type: 'percent', value: 20, section: 'discord' }));
  const chk = ok(await call('ana', 'POST', 'coupon/check', { items: [{ productId: A.id, qty: 2 }, { productId: B.id, qty: 1 }], coupon: 'DISC20' }));
  assert.strictEqual(chk.discount, 400);                 // 20% de 2×1000, não dos 3000 do Roblox
  assert.strictEqual(chk.total, 2000 + 3000 - 400 + 2000 * 0);

  const o = ok(await buy('ana', [{ productId: A.id, qty: 2 }, { productId: B.id, qty: 1 }, { productId: C.id, qty: 1 }, { productId: A.id, qty: 1 }], { coupon: 'DISC20' })).order;
  assert.strictEqual(o.lines.length, 3);                 // A repetido foi somado
  assert.strictEqual(o.lines[0].qty, 3);
  assert.strictEqual(o.subtotal, 3000 + 3000 + 2000);
  assert.strictEqual(o.discount, 1000);                  // Contas e Impulsos são da seção Discord: 20% de 3000 + 2000
  assert.strictEqual(o.total, 7000);
  assert.strictEqual((await stock(A.id)).count, 1);
  assert.strictEqual((await stock(C.id)).count, 2);
  assert.ok(o.lines.every((l) => l.delivered === null));
  assert.strictEqual(JSON.stringify(o).includes('exemplo.com/m.rbxl'), false);

  // paga: itens e link saem na hora, o manual fica pendente (pedido "pago", não "entregue")
  const paid = ok(await admin('admin/order', { id: o.id, action: 'pay' })).order;
  assert.strictEqual(paid.status, 'pago');
  const mine = await getOrder('ana', o.id);
  assert.deepStrictEqual(mine.lines[0].delivered.items, ['a1', 'a2', 'a3']);
  assert.strictEqual(mine.lines[1].delivered.download, true);
  assert.strictEqual(mine.lines[2].delivered, null);
  assert.ok(mine.lines[0].warrantyUntil > Date.now() && mine.lines[2].warrantyUntil === 0);   // garantia do manual conta da entrega
  assert.strictEqual((await admin('admin/order', { id: o.id, action: 'deliver', line: 1, text: 'x' })).status, 400);   // linha automática
  const done = ok(await admin('admin/order', { id: o.id, action: 'deliver', text: 'Boost feito' })).order;   // sem "line": primeira manual
  assert.strictEqual(done.status, 'entregue');
  assert.ok((await getOrder('ana', o.id)).lines[2].warrantyUntil > Date.now());
});

test('download: prazo, limite e renovação pelo admin', async () => {
  ok(await admin('admin/settings/save', { download: { days: 30, max: 2 } }));
  const o = ok(await buy('ana', [{ productId: B.id, qty: 1 }])).order;
  ok(await admin('admin/order', { id: o.id, action: 'pay' }));
  const go = () => call('ana', 'GET', 'download', null, `&id=${o.id}&line=0`);
  assert.strictEqual((await go()).h.location, 'https://exemplo.com/m.rbxl');
  assert.strictEqual((await go()).h.location, 'https://exemplo.com/m.rbxl');
  assert.match((await go()).h.location, /^\/#\/pedido\/.*erro=/);                 // limite atingido
  assert.strictEqual((await getOrder('ana', o.id)).lines[0].delivered.left, 0);
  ok(await admin('admin/order', { id: o.id, action: 'resetdl', line: 0 }));
  assert.strictEqual((await go()).h.location, 'https://exemplo.com/m.rbxl');
});

test('cupons: limite por cliente, primeira compra e afiliado', async () => {
  await mk('bia'); await mk('caio');
  ok(await admin('admin/coupon/save', { code: 'UMAVEZ', type: 'fixed', value: 100, perUser: 1 }));
  ok(await admin('admin/coupon/save', { code: 'PRIMEIRA', type: 'percent', value: 50, firstOrder: true }));
  ok(await admin('admin/coupon/save', { code: 'JOAO10', type: 'percent', value: 10, affiliateName: 'João', commissionPct: 20 }));
  const o1 = ok(await buy('bia', [{ productId: C.id, qty: 1 }], { coupon: 'UMAVEZ' })).order;
  assert.strictEqual((await buy('bia', [{ productId: C.id, qty: 1 }], { coupon: 'UMAVEZ' })).status, 400);       // já usou
  assert.strictEqual((await buy('caio', [{ productId: C.id, qty: 1 }], { coupon: 'UMAVEZ' })).status, 200);      // outro cliente pode
  assert.strictEqual((await buy('bia', [{ productId: C.id, qty: 1 }], { coupon: 'PRIMEIRA' })).status, 400);     // ela já tem pedido
  ok(await call('bia', 'POST', 'order/cancel', { id: o1.id }));
  assert.strictEqual((await buy('bia', [{ productId: C.id, qty: 1 }], { coupon: 'UMAVEZ' })).status, 200);       // cancelar devolve o uso
  // afiliado: receita e comissão só contam pedidos pagos
  const o2 = ok(await buy('caio', [{ productId: B.id, qty: 1 }], { coupon: 'JOAO10' })).order;
  let cp = ok(await admin('admin/coupons')).coupons.find((c) => c.code === 'JOAO10');
  assert.strictEqual(cp.revenue, 0);
  ok(await admin('admin/order', { id: o2.id, action: 'pay' }));
  cp = ok(await admin('admin/coupons')).coupons.find((c) => c.code === 'JOAO10');
  assert.deepStrictEqual([cp.revenue, cp.commission, cp.owed, cp.paidOrders], [2700, 540, 540, 1]);
  cp = ok(await admin('admin/coupon/payout', { code: 'JOAO10', amount: 300 })).coupon;
  assert.strictEqual(cp.paidOut, 300);
  ok(await admin('admin/order', { id: o2.id, action: 'refund' }));
  assert.strictEqual(ok(await admin('admin/coupons')).coupons.find((c) => c.code === 'JOAO10').revenue, 0);
});

test('avaliações: só quem comprou, média no produto, moderação e resposta', async () => {
  await mk('davi');
  assert.strictEqual((await call('davi', 'POST', 'review/save', { pid: B.id, rating: 5 })).status, 403);   // não comprou
  assert.strictEqual(ok(await call('ana', 'GET', 'reviews', null, '&pid=' + B.id)).canReview, true);
  ok(await call('ana', 'POST', 'review/save', { pid: B.id, rating: 5, text: 'Mapa excelente, recomendo!' }));
  ok(await call('ana', 'POST', 'review/save', { pid: B.id, rating: 4, text: 'Mapa muito bom, só faltou um detalhe.' }));   // editar, não duplicar
  let l = ok(await call('anon', 'GET', 'reviews', null, '&pid=' + B.id));
  assert.strictEqual(l.count, 1); assert.strictEqual(l.avg, 4); assert.strictEqual(l.reviews[0].name, 'Cliente A.');
  assert.strictEqual((await call('ana', 'POST', 'review/save', { pid: B.id, rating: 9, text: 'Mapa muito bom, só faltou um detalhe.' })).status, 200);       // 9 vira 5 (limite)
  assert.strictEqual((await call('ana', 'POST', 'review/save', { pid: B.id, rating: 0 })).status, 400);
  assert.strictEqual((await stockOf(B.id)).ratingCount, 1);
  const rv = ok(await admin('admin/reviews')).reviews[0];
  ok(await admin('admin/review', { action: 'reply', pid: rv.pid, uid: rv.uid, text: 'Obrigado!' }));
  assert.strictEqual(ok(await call('anon', 'GET', 'reviews', null, '&pid=' + B.id)).reviews[0].reply, 'Obrigado!');
  assert.strictEqual(ok(await call('anon', 'GET', 'reviews/recent')).reviews.length, 1);
  ok(await admin('admin/review', { action: 'hide', pid: rv.pid, uid: rv.uid }));
  l = ok(await call('anon', 'GET', 'reviews', null, '&pid=' + B.id));
  assert.strictEqual(l.count, 0); assert.strictEqual(l.reviews.length, 0);
  assert.strictEqual(ok(await call('anon', 'GET', 'reviews/recent')).reviews.length, 0);
});
const stockOf = async (pid) => (await call('anon', 'GET', 'products', null, '&id=' + pid)).body.products[0];

test('favoritos: avisa quando um produto esgotado volta ao estoque', async () => {
  const p = ok(await admin('admin/product/save', { name: 'Raro', categoryId: C.categoryId, price: 500, delivery: 'manual', qty: 0 })).product;
  ok(await call('davi', 'POST', 'wishlist/toggle', { pid: p.id, on: true }));
  assert.strictEqual(ok(await call('davi', 'GET', 'bootstrap')).wishBack, 0);
  assert.strictEqual(ok(await call('davi', 'GET', 'wishlist')).products[0].back, false);
  ok(await admin('admin/stock', { id: p.id, action: 'set', qty: 5 }));
  assert.strictEqual(ok(await call('davi', 'GET', 'bootstrap')).wishBack, 1);
  assert.strictEqual(ok(await call('davi', 'GET', 'wishlist')).products[0].back, true);
  ok(await call('davi', 'POST', 'wishlist/toggle', { pid: p.id, on: false }));
  assert.strictEqual(ok(await call('davi', 'GET', 'wishlist')).products.length, 0);
});

test('tickets e reposição na garantia', async () => {
  // suporte comum
  const t = ok(await call('ana', 'POST', 'ticket/new', { subject: 'Dúvida', text: 'Não entendi a entrega' })).ticket;
  assert.strictEqual(ok(await admin('admin/tickets', null, '&status=aberto')).tickets.length, 1);
  ok(await admin('admin/ticket/reply', { id: t.id, text: 'Já te ajudo' }));
  assert.strictEqual(ok(await call('ana', 'GET', 'ticket', null, '&id=' + t.id)).ticket.status, 'respondido');
  assert.strictEqual((await call('bia', 'GET', 'ticket', null, '&id=' + t.id)).status, 404);                 // ticket é privado
  ok(await call('ana', 'POST', 'ticket/reply', { id: t.id, text: 'Obrigada!' }));
  assert.strictEqual(ok(await call('ana', 'GET', 'ticket', null, '&id=' + t.id)).ticket.status, 'aberto');
  ok(await call('ana', 'POST', 'ticket/close', { id: t.id }));

  // reposição: só dentro da garantia, só com item entregue
  await mk('edu');
  const o = ok(await buy('edu', [{ productId: A.id, qty: 1 }])).order;
  assert.strictEqual((await call('edu', 'POST', 'ticket/new', { type: 'reposicao', orderId: o.id, line: 0, text: 'Conta caiu' })).status, 409);   // ainda não pago
  ok(await admin('admin/order', { id: o.id, action: 'pay' }));
  const item = (await getOrder('edu', o.id)).lines[0].delivered.items[0];
  assert.strictEqual((await call('edu', 'POST', 'ticket/new', { type: 'reposicao', orderId: o.id, line: 0, text: 'x' })).status, 400);              // texto curto
  const rt = ok(await call('edu', 'POST', 'ticket/new', { type: 'reposicao', orderId: o.id, line: 0, items: [item, 'invento'], text: 'A conta veio com senha errada' })).ticket;
  assert.deepStrictEqual(rt.ref.items, [item]);                                                               // item inventado é ignorado
  assert.strictEqual((await call('edu', 'POST', 'ticket/new', { type: 'reposicao', orderId: o.id, line: 0, text: 'de novo, por favor' })).status, 409);  // já tem um aberto
  assert.strictEqual((await call('ana', 'POST', 'ticket/new', { type: 'reposicao', orderId: o.id, line: 0, text: 'pedido de outro cliente' })).status, 404);
  ok(await admin('admin/stock', { id: A.id, action: 'add', lines: 'a5\na6' }));
  const before = (await stock(A.id)).count;
  ok(await admin('admin/ticket/approve', { id: rt.id }));
  assert.strictEqual((await stock(A.id)).count, before - 1);
  const rep = (await getOrder('edu', o.id)).lines[0].replacements;
  assert.strictEqual(rep.length, 1); assert.strictEqual(rep[0].items.length, 1);
  assert.strictEqual((await admin('admin/ticket/approve', { id: rt.id })).status, 409);                       // não repõe duas vezes

  // fora da garantia
  const keys = [...srv.store.data.keys()].filter((k) => k.startsWith('cd:o:'));
  const k = keys.find((x) => JSON.parse(srv.store.data.get(x).v).id === o.id);
  const raw = JSON.parse(srv.store.data.get(k).v); raw.lines[0].warrantyUntil = Date.now() - 1000; srv.store.data.get(k).v = JSON.stringify(raw);
  assert.strictEqual((await call('edu', 'POST', 'ticket/new', { type: 'reposicao', orderId: o.id, line: 0, text: 'garantia vencida' })).status, 409);
});

test('2FA: ativação, login com código, código de recuperação e bloqueio por tentativas', async () => {
  const s = ok(await call('adm', 'POST', 'account/2fa/setup', {}));
  assert.match(s.uri, /^otpauth:\/\/totp\//);
  const key = TOTP.dec(s.secret), step = () => Math.floor(Date.now() / 30000);
  assert.strictEqual((await call('adm', 'POST', 'account/2fa/enable', { code: '000000' })).status, 400);
  const en = ok(await call('adm', 'POST', 'account/2fa/enable', { code: TOTP.hotp(key, step()) }));
  assert.strictEqual(en.codes.length, 8); assert.strictEqual(en.user.twofa, true);
  cookie.adm = ''; // sai
  const login = (extra) => call('adm', 'POST', 'login', { email: 'dono@teste.com', password: 'senha-forte-1', ...extra });
  const r1 = ok(await login({}));
  assert.strictEqual(r1.needCode, true); assert.strictEqual(cookie.adm, '');                                 // senha certa sem código não abre sessão
  assert.strictEqual((await login({ code: '123456' })).status, 401);
  assert.strictEqual((await call('adm', 'GET', 'admin/stats')).status, 401);
  ok(await login({ code: TOTP.hotp(key, step() + 1) }));                                                     // o mesmo passo do setup já foi usado
  assert.strictEqual((await call('adm', 'GET', 'admin/stats')).status, 200);
  // código de recuperação funciona uma vez
  cookie.adm = '';
  ok(await login({ code: en.codes[0] }));
  cookie.adm = '';
  assert.strictEqual((await login({ code: en.codes[0] })).status, 401);
  // 10 erros travam a conta, até com a senha certa
  for (let i = 0; i < 9; i++) await login({ code: '000000' });
  assert.strictEqual((await login({ code: TOTP.hotp(key, step() + 1) })).status, 429);
  // desfaz: tira o bloqueio e desativa o 2FA para os próximos testes
  await require('../lib/redis').cmd(['DEL', 'cd:fail:dono@teste.com']);
  for (const k of [...srv.store.data.keys()]) if (k.startsWith('cd:rl:')) srv.store.data.delete(k);
  ok(await login({ code: en.codes[1] }));
  const rr = await call('adm', 'POST', 'account/2fa/disable', { password: 'senha-forte-1', code: en.codes[2] });
  assert.strictEqual(rr.body.user.twofa, false);
});

test('equipe: só o que o admin liberar', async () => {
  const me = ok(await call('ana', 'GET', 'bootstrap')).user.id;
  assert.strictEqual((await admin('admin/user', { id: me, action: 'staff', perms: [] })).status, 400);
  ok(await admin('admin/user', { id: me, action: 'staff', perms: ['pedidos', 'tickets', 'bogus'] }));
  const u = ok(await call('ana', 'POST', 'login', { email: 'ana@teste.com', password: 'senha-forte-2' })).user;
  assert.deepStrictEqual(u.perms, ['pedidos', 'tickets']);
  assert.strictEqual((await call('ana', 'GET', 'admin/orders')).status, 200);
  assert.strictEqual((await call('ana', 'GET', 'admin/tickets')).status, 200);
  for (const [m, r] of [['GET', 'admin/products'], ['GET', 'admin/stats'], ['GET', 'admin/users'], ['GET', 'admin/coupons'], ['GET', 'admin/settings'], ['GET', 'admin/logs'], ['GET', 'admin/export'], ['POST', 'admin/backup'], ['GET', 'admin/reviews']])
    assert.strictEqual((await call('ana', m, r, m === 'POST' ? {} : null)).status, 403, r);
  const any = ok(await admin('admin/orders')).orders.find((o) => o.status === 'pendente');
  assert.strictEqual((await call('ana', 'POST', 'admin/order', { id: any.id, action: 'pay' })).status, 403);   // dinheiro é só do admin
  assert.strictEqual((await call('ana', 'POST', 'admin/order', { id: any.id, action: 'note', text: 'oi' })).status, 200);
  ok(await admin('admin/user', { id: me, action: 'demote' }));
  assert.strictEqual((await call('ana', 'GET', 'admin/orders')).status, 403);
});

test('produtos em massa, duplicar, relatório, exportações e páginas', async () => {
  const dup = ok(await admin('admin/product/duplicate', { id: C.id })).product;
  assert.strictEqual(dup.active, false); assert.strictEqual(dup.name, 'Impulso (cópia)');
  assert.strictEqual(ok(await admin('admin/products')).products.find((p) => p.id === dup.id).stock.count, 0);
  assert.strictEqual((await admin('admin/product/bulk', { ids: [], action: 'hide' })).status, 400);
  ok(await admin('admin/product/bulk', { ids: [dup.id, C.id], action: 'price', percent: 10 }));
  assert.strictEqual(ok(await admin('admin/products')).products.find((p) => p.id === C.id).price, 2200);
  ok(await admin('admin/product/bulk', { ids: [dup.id], action: 'show' }));
  assert.strictEqual((await stockOf(dup.id)).id, dup.id);
  ok(await admin('admin/product/bulk', { ids: [dup.id], action: 'delete' }));
  assert.strictEqual((await call('anon', 'GET', 'products', null, '&id=' + dup.id)).body.products.length, 0);

  const rep = ok(await admin('admin/report', null, '&range=30'));
  assert.ok(rep.cur.revenue > 0 && rep.cur.paid >= 3 && rep.cur.created >= rep.cur.paid);
  assert.ok(rep.byProduct.length && rep.byCategory.length && rep.series.length >= 30);
  assert.ok(rep.cur.conversion > 0 && rep.cur.conversion <= 100);
  assert.strictEqual(ok(await admin('admin/report', null, '&range=mes')).range, 'mes');

  const today = new Date(Date.now() - 3 * 3600e3).toISOString().slice(0, 10);
  assert.ok(ok(await admin('admin/orders', null, `&from=${today}&to=${today}`)).orders.length > 0);
  assert.strictEqual(ok(await admin('admin/orders', null, '&from=2001-01-01&to=2001-01-02')).orders.length, 0);
  const csv = (await admin('admin/export', null, `&from=${today}&to=${today}`)).body;
  assert.ok(csv.includes('CD-') && csv.includes('2x Conta Discord'.replace('2x', '3x')) || csv.includes('x Conta Discord'));
  assert.ok((await admin('admin/export/users')).body.includes('dono@teste.com'));
  assert.ok((await admin('admin/export/logs')).body.includes('produto:criado'));

  // páginas: texto padrão, e o dono pode reescrever
  const pg = ok(await call('anon', 'GET', 'pages'));
  assert.ok(pg.terms.includes('Caarldev') && pg.faq.length >= 8);
  ok(await admin('admin/pages/save', { terms: 'Meus termos', refund: '', privacy: '', faq: [{ q: 'Pergunta?', a: 'Resposta.' }, { q: '', a: 'x' }] }));
  const pg2 = ok(await call('anon', 'GET', 'pages'));
  assert.strictEqual(pg2.terms, 'Meus termos'); assert.strictEqual(pg2.faq.length, 1); assert.ok(pg2.refund.includes('Garantia'));
  ok(await admin('admin/settings/save', { storeName: 'Caarldev' }));   // salvar só um campo não apaga o resto
  assert.strictEqual(ok(await call('anon', 'GET', 'pages')).terms, 'Meus termos');
});

test('avisos no Discord: webhook, eventos e estoque baixo', async () => {
  hooks.length = 0;
  assert.strictEqual((await admin('admin/discord/test', {})).status, 400);                  // sem webhook
  ok(await admin('admin/settings/save', { notify: { webhook: 'https://evil.example.com/hook', paid: true } }));
  assert.strictEqual(ok(await admin('admin/settings')).config.notify.webhook, '');          // só aceita endereço do Discord
  ok(await admin('admin/settings/save', { notify: { webhook: 'https://discord.com/api/webhooks/123456/abc-DEF_1', paid: true, attention: true, lowstock: true, ticket: true, contact: true, review: false, neworder: false } }));
  ok(await admin('admin/discord/test', {}));
  assert.strictEqual(hooks.length, 1);
  await mk('fabi');
  const p = ok(await admin('admin/product/save', { name: 'Poucas', categoryId: C.categoryId, price: 100, delivery: 'manual', qty: 2 })).product;
  const o = ok(await buy('fabi', [{ productId: p.id, qty: 1 }])).order;
  assert.strictEqual(hooks.length, 1);                                                       // neworder está desligado
  ok(await admin('admin/order', { id: o.id, action: 'pay' }));
  const titles = hooks.map((h) => h.embeds[0].title);
  assert.ok(titles.some((t) => t.startsWith('Pedido pago')), titles.join('|'));
  assert.ok(titles.some((t) => t.startsWith('Estoque baixo: Poucas')), titles.join('|'));
  assert.deepStrictEqual(hooks[hooks.length - 1].allowed_mentions, { parse: [] });          // nunca marca @everyone
  const before = hooks.length;
  ok(await call('fabi', 'POST', 'ticket/new', { text: 'Preciso de ajuda com o pedido' }));
  assert.strictEqual(hooks.length, before + 1);
  ok(await call('anon', 'POST', 'contact', { nome: 'Zé', email: 'ze@x.com', tipo: 'Animação', mensagem: 'Quero uma cutscene', prazo: '2 semanas', orcamento: 'R$ 500 a 1000', referencia: 'https://ref.exemplo.com/v' }));
  assert.strictEqual(hooks.length, before + 2);
  const m = ok(await admin('admin/messages')).messages[0];
  assert.strictEqual(m.prazo, '2 semanas'); assert.strictEqual(m.status, 'novo');
  ok(await admin('admin/message/status', { id: m.id, status: 'conversando' }));
  assert.strictEqual(ok(await admin('admin/messages')).messages[0].status, 'conversando');
});

test('backup e restauração', async () => {
  assert.strictEqual((await admin('admin/backup', { password: 'errada' })).status, 403);
  const raw = (await admin('admin/backup', { password: 'senha-forte-1' })).body;
  const data = typeof raw === 'string' ? JSON.parse(raw) : raw;
  assert.strictEqual(data.app, 'caarldev-loja');
  assert.ok(data.keys.some((k) => k.k === 'cd:cfg') && data.keys.some((k) => k.t === 'hash') && data.keys.some((k) => k.t === 'list'));
  assert.ok(!data.keys.some((k) => /^cd:(rl|fail|plock)/.test(k.k)));
  const before = (await stockOf(A.id)).stock.count;
  ok(await admin('admin/stock', { id: A.id, action: 'clear' }));
  assert.strictEqual((await stockOf(A.id)).stock.count, 0);
  assert.strictEqual((await admin('admin/restore', { password: 'senha-forte-1', data })).status, 400);       // falta confirmar
  assert.strictEqual((await admin('admin/restore', { password: 'senha-forte-1', confirm: 'RESTAURAR', data: { app: 'outro' } })).status, 400);
  assert.ok(ok(await admin('admin/restore', { password: 'senha-forte-1', confirm: 'RESTAURAR', data })).restored > 10);
  assert.strictEqual((await stockOf(A.id)).stock.count, before);
  assert.strictEqual(ok(await call('anon', 'GET', 'reviews', null, '&pid=' + B.id)).count, 0);              // hash restaurado (avaliação continua oculta)
});

test('chave de configuração do admin (sem verificação de e-mail)', async () => {
  process.env.ADMIN_EMAIL = 'dono2@teste.com'; process.env.ADMIN_SETUP_KEY = 'chave-secreta-do-dono';
  ids.x1 = 70;
  assert.strictEqual((await call('x1', 'POST', 'register', { name: 'Intruso', email: 'dono2@teste.com', password: 'senha-forte-9' })).status, 403);
  assert.strictEqual((await call('x1', 'POST', 'register', { name: 'Intruso', email: 'dono2@teste.com', password: 'senha-forte-9', setupKey: 'errada' })).status, 403);
  const r = ok(await call('x1', 'POST', 'register', { name: 'Dono2', email: 'dono2@teste.com', password: 'senha-forte-9', setupKey: 'chave-secreta-do-dono' }));
  assert.strictEqual(r.user.role, 'admin');
  assert.strictEqual(ok(await call('anon', 'POST', 'register', { name: 'Normal', email: 'normal@teste.com', password: 'senha-forte-9' })).user.role, 'user');   // os outros não precisam da chave
});

test('SEO: página do produto com prévia, dados estruturados e sitemap', async () => {
  const seo = require('../api/seo.js');
  const get = (url) => new Promise((resolve) => {
    const res = { statusCode: 200, h: {}, setHeader(k, v) { this.h[k.toLowerCase()] = v; }, end(t) { resolve({ status: this.statusCode, text: t, h: this.h }); } };
    seo({ url, headers: { host: 'loja.exemplo.com', 'x-forwarded-proto': 'https' } }, res);
  });
  const p = (await call('anon', 'GET', 'products', null, '&id=' + B.id)).body.products[0];
  const pg = await get(`/api/seo?t=p&id=${p.id}`);
  assert.strictEqual(pg.status, 200);
  assert.ok(pg.text.includes('<meta property="og:title" content="Mapa | Caarldev">'));
  assert.ok(pg.text.includes(`https://loja.exemplo.com/p/${p.id}`));
  assert.ok(pg.text.includes('"@type":"Product"') && pg.text.includes('"priceCurrency":"BRL"'));
  assert.ok(pg.text.includes('src="/app.js"'));                                       // caminho absoluto: funciona em /p/<id>
  assert.strictEqual((await get('/api/seo?t=p&id=nao-existe')).status, 404);
  const xss = await get('/api/seo?t=p&id=%22%3E%3Cscript%3E');
  assert.strictEqual(xss.text.includes('<script>'), false);
  const sm = await get('/api/seo?t=sitemap');
  assert.ok(sm.text.includes(`https://loja.exemplo.com/p/${p.id}`) && sm.text.includes('/s/discord'));
  assert.ok((await get('/api/seo?t=robots')).text.includes('Sitemap: https://loja.exemplo.com/sitemap.xml'));
  assert.ok((await get('/api/seo?t=s&sec=roblox')).text.includes('Mapa'));
  assert.strictEqual((await get('/api/seo?t=s&sec=hack')).status, 404);
});
