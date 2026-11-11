'use strict';
// Teste de ponta a ponta da loja (sem rede): node --test teste/loja.test.js
const test = require('node:test');
const assert = require('node:assert');
const fake = require('./fake-redis');
const CPF = '52998224725';

let call, srv, cookie = {};
test.before(async () => {
  srv = await fake.start(6398, 'rt');
  Object.assign(process.env, { KV_REST_API_URL: 'http://127.0.0.1:6398', KV_REST_API_TOKEN: 'rt', SESSION_SECRET: 'segredo-de-teste-1234567890', ADMIN_EMAIL: 'dono@teste.com', MISTICPAY_CLIENT_ID: 'pk_teste', MISTICPAY_CLIENT_SECRET: 'sk_teste' });
  require('./mp-mock').install();
  const handler = require('../api/store.js');
  call = async (who, method, route, body, q = '') => {
    const req = { method, url: `/api/store?r=${route}${q}`, headers: { 'x-requested-with': 'cd', 'x-forwarded-for': '1.1.1.' + who.length, cookie: cookie[who] || '' }, body };
    return new Promise((resolve) => {
      const res = { statusCode: 200, h: {}, setHeader(k, v) { this.h[k.toLowerCase()] = v; }, end(t) {
        if (this.h['set-cookie']) cookie[who] = this.h['set-cookie'].split(';')[0];
        let j; try { j = JSON.parse(t); } catch (_) { j = t; } resolve({ status: this.statusCode, body: j });
      } };
      handler(req, res);
    });
  };
});

test('fluxo completo: admin, produto, estoque, compra, pagamento, banimento', async () => {
  // anônimo não entra no admin
  assert.strictEqual((await call('anon', 'GET', 'admin/stats')).status, 401);
  // CSRF
  const bad = await new Promise((ok) => require('../api/store.js')({ method: 'POST', url: '/api/store?r=login', headers: {}, body: {} }, { setHeader() {}, end(t) { ok(this.statusCode); } }));
  assert.strictEqual(bad, 403);

  // o e-mail do ADMIN_EMAIL vira admin ao criar a conta; os outros não
  const a = await call('adm', 'POST', 'register', { name: 'Dono', email: 'DONO@teste.com', password: 'senha-forte-1' });
  assert.strictEqual(a.body.user.role, 'admin');
  const u = await call('cli', 'POST', 'register', { name: 'Cliente', email: 'cli@teste.com', password: 'senha-forte-2' });
  assert.strictEqual(u.body.user.role, 'user');
  assert.strictEqual((await call('cli', 'GET', 'admin/stats')).status, 403);
  assert.strictEqual((await call('x', 'POST', 'register', { name: 'Outro', email: 'cli@teste.com', password: 'senha-forte-2' })).status, 409);

  // categorias padrão + criar categoria nova em "Outros"
  const boot = (await call('anon', 'GET', 'bootstrap')).body;
  assert.ok(boot.categories.length >= 6);
  const orbs = boot.categories.find((c) => c.name === 'Farm de orbs');
  const rbxl = boot.categories.find((c) => c.name === 'Arquivos Rbxl');
  const nova = (await call('adm', 'POST', 'admin/category/save', { section: 'outros', name: 'Serviços' })).body.category;
  assert.strictEqual(nova.section, 'outros');

  // produto com itens em estoque (1 linha = 1 unidade)
  const p = (await call('adm', 'POST', 'admin/product/save', { name: 'Farm 100 orbs', categoryId: orbs.id, price: 1500, delivery: 'items', description: 'x' })).body.product;
  assert.strictEqual((await call('adm', 'POST', 'admin/stock', { id: p.id, action: 'add', lines: 'user1:senha1\nuser2:senha2\nuser3:senha3' })).body.added, 3);
  let pub = (await call('anon', 'GET', 'products', null, '&section=discord')).body.products;
  assert.strictEqual(pub[0].stock.count, 3);
  assert.strictEqual(pub[0].link, undefined);

  // produto Roblox por link, estoque ilimitado
  const rp = (await call('adm', 'POST', 'admin/product/save', { name: 'Mapa Cidade', categoryId: rbxl.id, price: 4990, delivery: 'link', link: 'https://exemplo.com/mapa.rbxl', unlimited: true })).body.product;
  assert.strictEqual((await call('adm', 'POST', 'admin/product/save', { name: 'Ruim', categoryId: rbxl.id, price: 1, delivery: 'link', link: 'javascript:alert(1)' })).status, 400);

  // cupom
  await call('adm', 'POST', 'admin/coupon/save', { code: 'promo10', type: 'percent', value: 10, maxUses: 1 });
  const chk = await call('cli', 'POST', 'coupon/check', { productId: p.id, qty: 2, coupon: 'PROMO10' });
  assert.strictEqual(chk.body.total, 2700);

  // compra: reserva o estoque e NÃO mostra o item antes de pagar
  const ord = (await call('cli', 'POST', 'order', { cpf: CPF, productId: p.id, qty: 2, coupon: 'promo10' })).body.order;
  assert.strictEqual(ord.status, 'pendente');
  assert.strictEqual(ord.total, 2700);
  assert.strictEqual(ord.delivery, null);
  assert.strictEqual(JSON.stringify(ord).includes('senha1'), false);
  pub = (await call('anon', 'GET', 'products', null, '&section=discord')).body.products;
  assert.strictEqual(pub[0].stock.count, 1);
  assert.strictEqual((await call('cli', 'POST', 'order', { cpf: CPF, productId: p.id, qty: 2 })).status, 409);       // sem estoque
  assert.strictEqual((await call('cli', 'POST', 'order', { cpf: CPF, productId: p.id, qty: 1, coupon: 'promo10' })).status, 400); // cupom esgotado

  // o PIX da MisticPay já vem pronto no pedido (sem CPF nem dados internos); admin ainda pode confirmar na mão
  assert.ok(ord.payment.copyPaste.startsWith('00020101'));
  assert.ok(ord.payment.qr.startsWith('data:image/png;base64,'));
  assert.strictEqual(JSON.stringify(ord).includes(CPF), false);
  assert.strictEqual((await call('cli', 'POST', 'order/claim', { id: ord.id })).status, 404);   // "já paguei" não existe mais
  assert.strictEqual((await call('cli', 'POST', 'order', { productId: p.id, qty: 1 })).status, 400);  // sem CPF
  const paid = (await call('adm', 'POST', 'admin/order', { id: ord.id, action: 'pay' })).body.order;
  assert.strictEqual(paid.status, 'entregue');
  const mine = (await call('cli', 'GET', 'order', null, '&id=' + ord.id)).body.order;
  assert.deepStrictEqual(mine.delivery.items, ['user1:senha1', 'user2:senha2']);
  // outro cliente não enxerga pedido alheio
  await call('cli2', 'POST', 'register', { name: 'Outro', email: 'o2@teste.com', password: 'senha-forte-3' });
  assert.strictEqual((await call('cli2', 'GET', 'order', null, '&id=' + ord.id)).status, 404);

  // produto por link entrega o link só depois de pago
  const o2 = (await call('cli', 'POST', 'order', { cpf: CPF, productId: rp.id, qty: 1 })).body.order;
  assert.strictEqual(JSON.stringify(o2).includes('exemplo.com'), false);
  await call('adm', 'POST', 'admin/order', { id: o2.id, action: 'pay' });
  assert.strictEqual((await call('cli', 'GET', 'order', null, '&id=' + o2.id)).body.order.delivery.url, 'https://exemplo.com/mapa.rbxl');

  // cancelar devolve o estoque
  const o3 = (await call('cli', 'POST', 'order', { cpf: CPF, productId: p.id, qty: 1 })).body.order;
  assert.strictEqual((await call('anon', 'GET', 'products', null, '&section=discord')).body.products[0].stock.count, 0);
  await call('cli', 'POST', 'order/cancel', { id: o3.id });
  assert.strictEqual((await call('anon', 'GET', 'products', null, '&section=discord')).body.products[0].stock.count, 1);

  // painel mostra as vendas
  const st = (await call('adm', 'GET', 'admin/stats')).body;
  assert.strictEqual(st.totals.revenue, 2700 + 4990);
  assert.strictEqual(st.totals.paidOrders, 2);
  assert.ok(st.lowStock.find((x) => x.id === p.id));
  assert.ok((await call('adm', 'GET', 'admin/export')).body.includes('CD-'));

  // banir: derruba a sessão na hora e bloqueia o login
  const cliId = (await call('adm', 'GET', 'admin/users')).body.users.find((x) => x.email === 'cli@teste.com').id;
  assert.strictEqual((await call('adm', 'POST', 'admin/user', { id: cliId, action: 'ban', reason: 'teste' })).status, 200);
  assert.strictEqual((await call('cli', 'GET', 'orders')).status, 403);
  assert.strictEqual((await call('cli', 'POST', 'login', { email: 'cli@teste.com', password: 'senha-forte-2' })).status, 403);
  await call('adm', 'POST', 'admin/user', { id: cliId, action: 'unban' });
  assert.strictEqual((await call('cli', 'POST', 'login', { email: 'cli@teste.com', password: 'senha-forte-2' })).status, 200);
  // admin do ambiente não pode ser banido nem apagado
  const admId = (await call('adm', 'GET', 'admin/users')).body.users.find((x) => x.role === 'admin').id;
  assert.strictEqual((await call('adm', 'POST', 'admin/user', { id: admId, action: 'ban' })).status, 403);

  // categoria com produtos exige destino ao apagar
  assert.strictEqual((await call('adm', 'POST', 'admin/category/delete', { id: orbs.id })).status, 409);
  assert.strictEqual((await call('adm', 'POST', 'admin/category/delete', { id: orbs.id, moveTo: nova.id })).status, 200);
});

test.after(() => srv && srv.server.close());
