'use strict';
// Pagamento automático (MisticPay) de ponta a ponta, sem rede: node --test teste/misticpay.test.js
const test = require('node:test');
const assert = require('node:assert');
const fake = require('./fake-redis');
const CPF = '52998224725';

let srv, mp, call, hook, S, cookie = {}, prod, seq = 0;
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));

test.before(async () => {
  srv = await fake.start(6397, 'mp');
  Object.assign(process.env, { KV_REST_API_URL: 'http://127.0.0.1:6397', KV_REST_API_TOKEN: 'mp', SESSION_SECRET: 'segredo-de-teste-1234567890', ADMIN_EMAIL: 'dono@teste.com', MISTICPAY_CLIENT_ID: 'pk_teste', MISTICPAY_CLIENT_SECRET: 'sk_teste', SITE_URL: 'https://loja.exemplo.com/' });
  mp = require('./mp-mock').install();
  const handler = require('../api/store.js');
  hook = require('../api/webhook.js');
  S = require('../lib/shop.js');
  call = (who, method, route, body, q = '') => new Promise((resolve) => {
    const req = { method, url: `/api/store?r=${route}${q}`, headers: { 'x-requested-with': 'cd', 'x-forwarded-for': '9.9.9.' + who.length, cookie: cookie[who] || '' }, body };
    const res = { statusCode: 200, h: {}, setHeader(k, v) { this.h[k.toLowerCase()] = v; }, end(t) {
      if (this.h['set-cookie']) cookie[who] = this.h['set-cookie'].split(';')[0];
      let j; try { j = JSON.parse(t); } catch (_) { j = t; } resolve({ status: this.statusCode, body: j });
    } };
    handler(req, res);
  });
  await call('adm', 'POST', 'register', { name: 'Dono', email: 'dono@teste.com', password: 'senha-forte-1' });
    const cat = (await call('anon', 'GET', 'bootstrap')).body.categories.find((c) => c.name === 'Farm de orbs');
  prod = (await call('adm', 'POST', 'admin/product/save', { name: 'Farm 100 orbs', categoryId: cat.id, price: 2700, delivery: 'items' })).body.product;
  await call('adm', 'POST', 'admin/stock', { id: prod.id, action: 'add', lines: Array.from({ length: 20 }, (_, i) => `conta${i}:senha${i}`).join('\n') });
});
test.after(() => srv && srv.server.close());

const stock = async () => (await call('anon', 'GET', 'products', null, '&section=discord')).body.products.find((p) => p.id === prod.id).stock.count;
// O site limita 12 pedidos por hora por cliente; o teste troca de cliente de vez em quando.
const owner = new Map();
const buy = async (extra = {}) => {
  const who = 'cli' + Math.floor(seq++ / 6);
  if (!cookie[who]) await call(who, 'POST', 'register', { name: 'Maria Cliente', email: `${who}@teste.com`, password: 'senha-forte-2' });
  const r = await call(who, 'POST', 'order', { productId: prod.id, qty: 1, cpf: CPF, ...extra });
  if (r.body && r.body.order) owner.set(r.body.order.id, who);
  return r;
};
const getOrder = async (id) => (await call(owner.get(id) || 'adm', 'GET', 'order', null, '&id=' + id)).body.order;
const send = (body) => new Promise((resolve) => {
  const res = { code: 200, body: null, setHeader() {}, status(c) { this.code = c; return this; }, json(b) { this.body = b; resolve(this); return this; } };
  hook({ method: 'POST', headers: {}, body }, res);
});
const waitSettle = async () => { await sleep(80); };
const pay = (o, patch = {}) => Object.assign(mp.charges.get(o.id), { state: 'COMPLETO' }, patch);
// espera um pedido ficar fora da fila de "refreshPayment" (a página só consulta a cada 6 s)
const unthrottle = async (o) => { await require('../lib/redis').cmd(['DEL', S.K.payChk(o.id)]); };

test('cria a cobrança PIX com valor em reais, id do pedido, webhook e credencial Basic', async () => {
  const r = await buy();
  assert.strictEqual(r.status, 200);
  const o = r.body.order;
  const c = mp.calls.filter((x) => x.path === '/transactions/create').pop();
  assert.strictEqual(c.body.amount, 27);                                   // R$ 27,00 (reais, não centavos)
  assert.strictEqual(c.body.transactionId, o.id);
  assert.strictEqual(c.body.payerDocument, CPF);
  assert.strictEqual(c.body.payerName, 'Maria Cliente');
  assert.strictEqual(c.body.projectWebhook, 'https://loja.exemplo.com/api/webhook');
  assert.strictEqual(c.auth, 'Basic ' + Buffer.from('pk_teste:sk_teste').toString('base64'));
  assert.ok(o.payment.copyPaste && o.payment.qr);
  assert.strictEqual(JSON.stringify(o).includes(CPF), false);              // CPF não é guardado nem devolvido
  assert.strictEqual(JSON.stringify(await S.getOrder(o.id)).includes(CPF), false);
});

test('CPF inválido é recusado antes de reservar estoque', async () => {
  const before = await stock();
  assert.strictEqual((await buy({ cpf: '111.111.111-11' })).status, 400);
  assert.strictEqual((await buy({ cpf: '' })).status, 400);
  assert.strictEqual(await stock(), before);
});

test('se a MisticPay falhar, o pedido é cancelado e o estoque volta', async () => {
  const before = await stock();
  mp.failCreate = true;
  const r = await buy();
  mp.failCreate = false;
  assert.strictEqual(r.status, 502);
  assert.strictEqual(await stock(), before);
  mp.down = true;
  assert.strictEqual((await buy()).status, 502);
  mp.down = false;
  assert.strictEqual(await stock(), before);
});

test('webhook falso (diz COMPLETO, mas a MisticPay diz PENDENTE) NÃO libera nada', async () => {
  const o = (await buy()).body.order;
  const r = await send({ transactionId: o.id, transactionType: 'DEPOSITO', status: 'COMPLETO', value: 2700 });
  assert.strictEqual(r.code, 200);
  assert.strictEqual(r.body.status, 'pendente');
  const n = await getOrder(o.id);
  assert.strictEqual(n.status, 'pendente');
  assert.strictEqual(n.delivery, null);
});

test('webhook real libera e entrega uma vez só, mesmo repetido e em paralelo', async () => {
  const o = (await buy()).body.order;
  const sold0 = (await S.getJ(S.K.prod(prod.id))).sold || 0;
  pay(o);
  const txId = mp.charges.get(o.id).txId;
  // chega 3x ao mesmo tempo, um deles pelo id interno da MisticPay (é o que ela manda no depósito)
  await Promise.all([send({ transactionId: o.id, transactionType: 'DEPOSITO', status: 'COMPLETO' }), send({ transactionId: txId, transactionType: 'DEPOSITO', status: 'COMPLETO' }), send({ transactionId: Number(txId), transactionType: 'DEPOSITO', status: 'COMPLETO' })]);
  await waitSettle();
  await send({ transactionId: o.id, status: 'COMPLETO' });                 // reenvio depois
  const n = await getOrder(o.id);
  assert.strictEqual(n.status, 'entregue');
  assert.strictEqual(n.delivery.items.length, 1);
  assert.strictEqual((await S.getJ(S.K.prod(prod.id))).sold, sold0 + 1);
  const hist = (await S.getOrder(o.id)).history.filter((h) => /Pagamento confirmado/.test(h.what));
  assert.strictEqual(hist.length, 1);
});

test('se o webhook atrasar, abrir o pedido já confirma o pagamento', async () => {
  const o = (await buy()).body.order;
  pay(o);
  await unthrottle(o);
  const n = await getOrder(o.id);
  assert.strictEqual(n.status, 'entregue');
  assert.strictEqual(n.delivery.items.length, 1);
});

test('valor pago menor que o pedido fica para o admin, sem liberar', async () => {
  const o = (await buy()).body.order;
  pay(o, { paidValue: 10 });
  await unthrottle(o);
  const n = await getOrder(o.id);
  assert.strictEqual(n.status, 'pendente');
  const adm = (await call('adm', 'GET', 'admin/orders', null, '&q=' + o.code)).body.orders[0];
  assert.match(adm.payIssue, /menor/);
  assert.strictEqual(adm.pay, undefined);                                  // o QR/código não vai para a lista do admin
  assert.strictEqual(adm.payRef, mp.charges.get(o.id).txId);
});

test('pagamento depois de expirar reabre o pedido e entrega', async () => {
  const o = (await buy()).body.order;
  await S.closeOpen(await S.getOrder(o.id), 'sistema', 'expirado', 'Pedido expirado sem pagamento');
  pay(o);
  const r = await send({ transactionId: o.id, status: 'COMPLETO' });
  assert.strictEqual(r.body.status, 'entregue');
  assert.strictEqual((await getOrder(o.id)).delivery.items.length, 1);
});

test('pagamento depois de cancelar não entrega: avisa o admin', async () => {
  const o = (await buy()).body.order;
  assert.strictEqual((await call(owner.get(o.id), 'POST', 'order/cancel', { id: o.id })).status, 200);
  const before = await stock();
  pay(o);
  await send({ transactionId: o.id, status: 'COMPLETO' });
  const n = await S.getOrder(o.id);
  assert.strictEqual(n.status, 'cancelado');
  assert.match(n.payIssue, /cancelado/);
  assert.strictEqual(await stock(), before);
});

test('reembolso e MED são registrados sem mudar a entrega', async () => {
  const o = (await buy()).body.order;
  pay(o);
  await send({ transactionId: o.id, status: 'COMPLETO' });
  await send({ transactionId: o.id, transactionType: 'DEPOSITO', status: 'DEVOLVIDO', refund: { status: 'CONCLUIDO', refundedValue: 2700 } });
  let n = await S.getOrder(o.id);
  assert.strictEqual(n.status, 'entregue');
  assert.match(n.payIssue, /reembolso/);
  await send({ event: 'INFRACTION', infraction: { id: 1, status: 'WAITING_PSP', type: 'FRAUD' }, transaction: { transactionId: o.id } });
  n = await S.getOrder(o.id);
  assert.match(n.payIssue, /MED/);
  const logs = (await call('adm', 'GET', 'admin/logs')).body.logs.map((l) => l.action);
  assert.ok(logs.includes('pagamento:reembolso') && logs.includes('pagamento:med') && logs.includes('pagamento:confirmado'));
  // o admin reembolsa de verdade e o alerta some
  await call('adm', 'POST', 'admin/order', { id: o.id, action: 'refund', restock: false });
  assert.strictEqual((await S.getOrder(o.id)).payIssue, undefined);
});

test('webhook de pedido desconhecido, de saque ou inválido não consulta nem quebra', async () => {
  const n0 = mp.calls.length;
  assert.strictEqual((await send({ transactionId: 'nao-existe', status: 'COMPLETO' })).code, 200);
  assert.strictEqual((await send({ transactionType: 'RETIRADA', transactionId: 1, status: 'COMPLETO' })).code, 200);
  assert.strictEqual((await send({})).code, 200);
  assert.strictEqual(mp.calls.length, n0);
  const bad = await new Promise((resolve) => { const res = { code: 200, setHeader() {}, status(c) { this.code = c; return this; }, json() { resolve(this.code); return this; } }; hook({ method: 'POST', headers: {}, body: 'isso não é json' }, res); });
  assert.strictEqual(bad, 400);
  const get = await new Promise((resolve) => { const res = { code: 200, setHeader() {}, status(c) { this.code = c; return this; }, json() { resolve(this.code); return this; } }; hook({ method: 'GET', headers: {} }, res); });
  assert.strictEqual(get, 405);
});

test('MisticPay fora do ar no webhook devolve 500 para ela tentar de novo', async () => {
  const o = (await buy()).body.order;
  pay(o);
  mp.down = true;
  const r = await send({ transactionId: o.id, status: 'COMPLETO' });
  mp.down = false;
  assert.strictEqual(r.code, 500);
  assert.strictEqual((await send({ transactionId: o.id, status: 'COMPLETO' })).body.status, 'entregue');   // na segunda tentativa libera
});

test('pedido que expira com PIX já pago é liberado em vez de expirar', async () => {
  const o = (await buy()).body.order;
  const raw = await S.getOrder(o.id); raw.expiresAt = Date.now() - 1000; await S.saveOrder(raw);
  pay(o);
  await S.sweepExpired(true);
  assert.strictEqual((await S.getOrder(o.id)).status, 'entregue');
});
