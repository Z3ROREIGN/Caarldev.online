'use strict';
// Carteira de ponta a ponta, sem rede (MisticPay simulada): node --test teste/carteira.test.js
const test = require('node:test');
const assert = require('node:assert');
const fake = require('./fake-redis');
const CPF = '52998224725';

let srv, mp, handler, hook, cookie = {}, prod;
const ips = {};
const ipOf = (who) => ips[who] || (ips[who] = `10.1.${Object.keys(ips).length + 1}.1`);

test.before(async () => {
  srv = await fake.start(6396, 'wl');
  Object.assign(process.env, { KV_REST_API_URL: 'http://127.0.0.1:6396', KV_REST_API_TOKEN: 'wl', SESSION_SECRET: 'segredo-de-teste-1234567890', ADMIN_EMAIL: 'dono@teste.com', MISTICPAY_CLIENT_ID: 'pk_teste', MISTICPAY_CLIENT_SECRET: 'sk_teste', SITE_URL: 'https://loja.exemplo.com' });
  mp = require('./mp-mock').install();
  handler = require('../api/store.js');
  hook = require('../api/webhook.js');
  await call('adm', 'POST', 'register', { name: 'Dono', email: 'dono@teste.com', password: 'senha-forte-1' });
  const cat = (await call('anon', 'GET', 'bootstrap')).body.categories.find((c) => c.name === 'Farm de orbs');
  prod = (await call('adm', 'POST', 'admin/product/save', { name: 'Farm 100 orbs', categoryId: cat.id, price: 2700, delivery: 'items' })).body.product;
  await call('adm', 'POST', 'admin/stock', { id: prod.id, action: 'add', lines: Array.from({ length: 30 }, (_, i) => `conta${i}:senha${i}`).join('\n') });
});
test.after(() => srv && srv.server.close());

// Chamada da loja (com cookie) ou da API pública (com chave: passe { key })
const call = (who, method, route, body, q = '', key) => new Promise((resolve) => {
  const headers = { 'x-forwarded-for': ipOf(who) };
  if (key) headers.authorization = `Bearer ${key}`; else { headers['x-requested-with'] = 'cd'; headers.cookie = cookie[who] || ''; }
  const req = { method, url: `/api/store?r=${route}${q}`, headers, body };
  const res = { statusCode: 200, h: {}, setHeader(k, v) { this.h[k.toLowerCase()] = v; }, end(t) {
    if (this.h['set-cookie']) cookie[who] = this.h['set-cookie'].split(';')[0];
    let j; try { j = JSON.parse(t); } catch (_) { j = t; } resolve({ status: this.statusCode, body: j });
  } };
  handler(req, res);
});
const send = (body) => new Promise((resolve) => {
  const res = { code: 200, body: null, setHeader() {}, status(c) { this.code = c; return this; }, json(b) { this.body = b; resolve(this); return this; } };
  hook({ method: 'POST', headers: {}, body }, res);
});
const user = async (who) => { await call(who, 'POST', 'register', { name: `${who} Silva`, email: `${who}@teste.com`, password: 'senha-forte-2' }); return who; };
const bal = async (who) => (await call(who, 'GET', 'wallet')).body.balance;
const PW = { password: 'senha-forte-2' };
// Recarrega pelo fluxo real: gera o PIX, a MisticPay "paga" e o webhook chega.
const topup = async (who, cents) => {
  const r = await call(who, 'POST', 'wallet/deposit', { amount: cents, cpf: CPF });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  mp.charges.get(r.body.deposit.id).state = 'COMPLETO';
  await send({ transactionId: r.body.deposit.id, transactionType: 'DEPOSITO', status: 'COMPLETO' });
  return r.body.deposit;
};
const stock = async () => (await call('anon', 'GET', 'products', null, '&section=discord')).body.products.find((p) => p.id === prod.id).stock.count;
const walletTotals = async () => (await call('adm', 'GET', 'admin/wallet')).body.totals;

test('recarga: gera PIX com id "rc", credita uma vez e o webhook repetido não duplica', async () => {
  await user('alice');
  assert.strictEqual(await bal('alice'), 0);
  const r = await call('alice', 'POST', 'wallet/deposit', { amount: 5000, cpf: CPF });
  assert.strictEqual(r.status, 200);
  const d = r.body.deposit;
  assert.match(d.id, /^rc[0-9a-f]{14}$/);
  assert.ok(d.pay.copyPaste);
  const c = mp.calls.filter((x) => x.path === '/transactions/create').pop();
  assert.strictEqual(c.body.amount, 50);                       // reais, não centavos
  assert.strictEqual(c.body.transactionId, d.id);
  assert.strictEqual(c.body.projectWebhook, 'https://loja.exemplo.com/api/webhook');

  // aviso falso: a MisticPay ainda diz PENDENTE, então não credita
  await send({ transactionId: d.id, transactionType: 'DEPOSITO', status: 'COMPLETO' });
  assert.strictEqual(await bal('alice'), 0);

  mp.charges.get(d.id).state = 'COMPLETO';
  assert.strictEqual((await send({ transactionId: d.id, transactionType: 'DEPOSITO', status: 'COMPLETO' })).body.status, 'pago');
  assert.strictEqual(await bal('alice'), 5000);
  await send({ transactionId: d.id, transactionType: 'DEPOSITO', status: 'COMPLETO' });
  await Promise.all([send({ transactionId: d.id, transactionType: 'DEPOSITO', status: 'COMPLETO' }), send({ transactionId: d.id, transactionType: 'DEPOSITO', status: 'COMPLETO' })]);
  assert.strictEqual(await bal('alice'), 5000);                 // nada em dobro

  const w = (await call('alice', 'GET', 'wallet')).body;
  assert.strictEqual(w.ledger[0].type, 'recarga');
  assert.strictEqual(w.ledger[0].balance, 5000);
  assert.strictEqual(w.deposits[0].status, 'pago');
});

test('recarga: valida valor mínimo, CPF e a página confirma sozinha se o webhook atrasar', async () => {
  assert.strictEqual((await call('alice', 'POST', 'wallet/deposit', { amount: 50, cpf: CPF })).status, 400);
  assert.strictEqual((await call('alice', 'POST', 'wallet/deposit', { amount: 1000, cpf: '11111111111' })).status, 400);
  assert.strictEqual((await call('alice', 'POST', 'wallet/deposit', { amount: 99999999, cpf: CPF })).status, 400);
  assert.strictEqual((await call('anon', 'POST', 'wallet/deposit', { amount: 1000, cpf: CPF })).status, 401);
  const r = await call('alice', 'POST', 'wallet/deposit', { amount: 1000, cpf: CPF });
  mp.charges.get(r.body.deposit.id).state = 'COMPLETO';
  const s = await call('alice', 'GET', 'wallet/deposit', null, '&id=' + r.body.deposit.id);   // sem webhook
  assert.strictEqual(s.body.deposit.status, 'pago');
  assert.strictEqual(await bal('alice'), 6000);
  // recarga de outra pessoa não aparece
  await user('mallory');
  assert.strictEqual((await call('mallory', 'GET', 'wallet/deposit', null, '&id=' + r.body.deposit.id)).status, 404);
});

test('recarga: cancelar, e PIX pago depois de cancelar ainda credita', async () => {
  const r = await call('alice', 'POST', 'wallet/deposit', { amount: 2000, cpf: CPF });
  const id = r.body.deposit.id;
  assert.strictEqual((await call('alice', 'POST', 'wallet/deposit/cancel', { id })).body.deposit.status, 'cancelado');
  mp.charges.get(id).state = 'COMPLETO';
  await send({ transactionId: id, transactionType: 'DEPOSITO', status: 'COMPLETO' });
  assert.strictEqual(await bal('alice'), 8000);
});

test('compra com saldo: entrega na hora, sem CPF, e saldo insuficiente não mexe em nada', async () => {
  const before = await stock();
  const r = await call('alice', 'POST', 'order', { terms: true, productId: prod.id, qty: 1, payWith: 'wallet' });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.strictEqual(r.body.order.status, 'entregue');
  assert.strictEqual(r.body.order.paidWith, 'wallet');
  assert.strictEqual(r.body.order.lines[0].delivered.items.length, 1);
  assert.strictEqual(await bal('alice'), 8000 - 2700);
  assert.strictEqual(await stock(), before - 1);
  const led = (await call('alice', 'GET', 'wallet')).body.ledger[0];
  assert.strictEqual(led.type, 'compra'); assert.strictEqual(led.amount, -2700);

  // 5 itens = R$ 135,00 com R$ 53,00 na carteira
  const bad = await call('alice', 'POST', 'order', { terms: true, productId: prod.id, qty: 5, payWith: 'wallet' });
  assert.strictEqual(bad.status, 402);
  assert.strictEqual(await bal('alice'), 5300);
  assert.strictEqual(await stock(), before - 1);                // estoque intacto
  assert.strictEqual(mp.calls.filter((x) => x.path === '/transactions/create' && x.body.amount === 135).length, 0);  // não gerou PIX
});

test('compra com saldo: PIX continua funcionando e o reembolso do admin devolve à carteira', async () => {
  const pix = await call('alice', 'POST', 'order', { terms: true, productId: prod.id, qty: 1, cpf: CPF });
  assert.strictEqual(pix.body.order.status, 'pendente');
  assert.ok(pix.body.order.payment.copyPaste);
  assert.strictEqual(await bal('alice'), 5300);                 // PIX não mexe no saldo
  await call('alice', 'POST', 'order/cancel', { id: pix.body.order.id });

  const orders = (await call('alice', 'GET', 'orders')).body.orders;
  const paid = orders.find((o) => o.paidWith === 'wallet');
  const rf = await call('adm', 'POST', 'admin/order', { id: paid.id, action: 'refund', restock: false });
  assert.strictEqual(rf.status, 200);
  assert.strictEqual(await bal('alice'), 5300 + 2700);
  assert.strictEqual((await call('alice', 'GET', 'wallet')).body.ledger[0].type, 'estorno');
  assert.strictEqual((await call('adm', 'POST', 'admin/order', { id: paid.id, action: 'refund' })).status, 409);   // não reembolsa duas vezes
  assert.strictEqual(await bal('alice'), 8000);
});

test('transferência: quem envia paga valor + R$ 0,50, quem recebe leva valor - R$ 0,50', async () => {
  await user('bob');
  const f0 = (await walletTotals()).fees;
  const r = await call('alice', 'POST', 'wallet/transfer', { to: 'BOB@teste.com', amount: 1000, note: 'obrigado', ...PW });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.strictEqual(r.body.transfer.charged, 1050);
  assert.strictEqual(r.body.transfer.received, 950);
  assert.strictEqual(await bal('alice'), 8000 - 1050);
  assert.strictEqual(await bal('bob'), 950);
  assert.strictEqual((await walletTotals()).fees - f0, 100);    // R$ 1,00 de taxas para a loja
  const a = (await call('alice', 'GET', 'wallet')).body.ledger[0], b = (await call('bob', 'GET', 'wallet')).body.ledger[0];
  assert.deepStrictEqual([a.type, a.amount, a.fee], ['envio', -1050, 50]);
  assert.deepStrictEqual([b.type, b.amount, b.fee], ['recebido', 950, 50]);
  assert.strictEqual(b.who, 'alice S.');
});

test('transferência: senha, destinatário, mínimo, saldo e ninguém fica no vermelho', async () => {
  const t = (body, who = 'alice') => call(who, 'POST', 'wallet/transfer', { to: 'bob@teste.com', amount: 500, ...PW, ...body });
  assert.strictEqual((await t({ password: 'errada-123' })).status, 403);
  assert.strictEqual((await t({ password: '' })).status, 403);
  assert.strictEqual((await t({ to: 'alice@teste.com' })).status, 400);        // para si mesma
  assert.strictEqual((await t({ to: 'ninguem@teste.com' })).status, 404);
  assert.strictEqual((await t({ to: 'isso-nao-e-email' })).status, 400);
  assert.strictEqual((await t({ amount: 99 })).status, 400);                   // abaixo do mínimo
  assert.strictEqual((await t({ amount: 99999999 })).status, 402);
  assert.strictEqual((await call('anon', 'POST', 'wallet/transfer', { to: 'bob@teste.com', amount: 500, ...PW })).status, 401);
  assert.strictEqual((await call('alice', 'POST', 'wallet/transfer', { to: 'bob@teste.com', amount: 500 })).status, 403);   // sem a senha: a sessão sozinha não basta
  assert.strictEqual(await bal('alice'), 6950);
  assert.strictEqual(await bal('bob'), 950);
});

test('transferência: pedidos ao mesmo tempo nunca gastam mais do que o saldo (nada de saldo negativo)', async () => {
  await user('carol'); await user('dave');
  await topup('carol', 5000);                                                  // R$ 50,00
  const before = await walletTotals();
  // cada envio custa R$ 30,50 (30 + taxa): só 1 cabe em R$ 50,00
  const rs = await Promise.all(Array.from({ length: 6 }, () => call('carol', 'POST', 'wallet/transfer', { to: 'dave@teste.com', amount: 3000, ...PW })));
  const ok = rs.filter((x) => x.status === 200).length;
  assert.strictEqual(ok, 1, rs.map((x) => x.status).join());
  assert.ok(rs.every((x) => x.status === 200 || x.status === 402 || x.status === 429));
  assert.strictEqual(await bal('carol'), 5000 - 3050);
  assert.strictEqual(await bal('dave'), 2950);
  assert.ok((await walletTotals()).total >= 0 && before.total >= 0);
});

test('saque: taxa de 5% + R$ 0,50, fica pendente, só sai com a aprovação do admin e só vira "enviado" quando a MisticPay conclui', async () => {
  await topup('bob', 5000);                                                    // bob: 9,50 + 50,00 = 59,50
  const start = await bal('bob');
  const r = await call('bob', 'POST', 'wallet/withdraw', { amount: 2000, keyType: 'CPF', key: '529.982.247-25', ...PW });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  const w = r.body.withdrawal;
  assert.deepStrictEqual([w.amount, w.fee, w.net, w.status], [2000, 150, 1850, 'pendente']);   // 5% de 20,00 = 1,00 + 0,50 = 1,50
  assert.strictEqual(w.key, '••••4725');                                      // o cliente só vê a chave mascarada
  assert.strictEqual(await bal('bob'), start - 2000);
  assert.strictEqual(mp.withdraws.length, 0);                                  // nada saiu sozinho

  // cliente não aprova o próprio saque; admin precisa confirmar a senha
  assert.strictEqual((await call('bob', 'POST', 'admin/wallet/withdraw', { id: w.id, action: 'approve', password: 'senha-forte-2' })).status, 403);
  assert.strictEqual((await call('adm', 'POST', 'admin/wallet/withdraw', { id: w.id, action: 'approve' })).status, 403);
  const f0 = (await walletTotals()).fees;
  const ok = await call('adm', 'POST', 'admin/wallet/withdraw', { id: w.id, action: 'approve', password: 'senha-forte-1' });
  assert.strictEqual(ok.body.withdrawal.status, 'enviando');                   // entrou na fila da MisticPay, ainda não concluiu
  assert.strictEqual(mp.withdraws.length, 1);
  assert.deepStrictEqual([mp.withdraws[0].amount, mp.withdraws[0].pixKey, mp.withdraws[0].pixKeyType], [18.5, '52998224725', 'CPF']);   // chega líquido, em reais
  const call1 = mp.calls.filter((x) => x.path === '/transactions/withdraw')[0];
  assert.match(call1.headers['X-Idempotency-Key'], /^carteira-saque-/);        // repetir nunca duplica o PIX
  assert.strictEqual(call1.body.projectWebhook, 'https://loja.exemplo.com/api/webhook');
  assert.strictEqual((await call('bob', 'GET', 'wallet')).body.withdrawals[0].status, 'enviando');
  assert.strictEqual((await walletTotals()).fees - f0, 0);                     // taxa só conta quando concluir

  const ref = ok.body.withdrawal.id && [...mp.wd.keys()][0];
  await send({ transactionId: ref, transactionType: 'RETIRADA', status: 'COMPLETO' });          // aviso falso: a MisticPay ainda diz PENDENTE
  assert.strictEqual((await call('bob', 'GET', 'wallet')).body.withdrawals[0].status, 'enviando');
  mp.wd.get(ref).state = 'COMPLETO';
  await send({ transactionId: ref, transactionType: 'RETIRADA', status: 'COMPLETO' });
  assert.strictEqual((await call('bob', 'GET', 'wallet')).body.withdrawals[0].status, 'enviado');
  assert.strictEqual((await walletTotals()).fees - f0, 150);
  await send({ transactionId: ref, transactionType: 'RETIRADA', status: 'COMPLETO' });          // repetido: não conta a taxa de novo
  assert.strictEqual((await walletTotals()).fees - f0, 150);
  assert.strictEqual((await call('adm', 'POST', 'admin/wallet/withdraw', { id: w.id, action: 'approve', password: 'senha-forte-1' })).status, 409);   // não manda outro PIX
  assert.strictEqual(mp.withdraws.length, 1);
});

test('saque: recusado devolve o saldo; chave inválida, mínimo e saldo são barrados', async () => {
  const start = await bal('bob');
  const bad = (b) => call('bob', 'POST', 'wallet/withdraw', { amount: 2000, keyType: 'CPF', key: CPF, ...PW, ...b });
  assert.strictEqual((await bad({ key: '123' })).status, 400);
  assert.strictEqual((await bad({ keyType: 'EMAIL', key: 'x' })).status, 400);
  assert.strictEqual((await bad({ keyType: 'CNPJ', key: '11222333000182' })).status, 400);
  assert.strictEqual((await bad({ keyType: 'XYZ' })).status, 400);
  assert.strictEqual((await bad({ amount: 500 })).status, 400);                // mínimo R$ 10,00
  assert.strictEqual((await bad({ amount: 150000 })).status, 402);              // acima do saldo (e dentro do limite diário)
  assert.strictEqual((await bad({ password: 'errada-123' })).status, 403);
  assert.strictEqual(await bal('bob'), start);
  assert.ok(require('../lib/wallet').isCnpj('11222333000181'));

  const r = await bad({ keyType: 'EMAIL', key: 'Bob@Banco.com' });
  assert.strictEqual(r.body.withdrawal.key, 'b***@banco.com');
  assert.strictEqual(await bal('bob'), start - 2000);
  const rej = await call('adm', 'POST', 'admin/wallet/withdraw', { id: r.body.withdrawal.id, action: 'reject', reason: 'chave de terceiros' });
  assert.strictEqual(rej.body.withdrawal.status, 'recusado');
  assert.strictEqual(await bal('bob'), start);
  assert.strictEqual((await call('adm', 'POST', 'admin/wallet/withdraw', { id: r.body.withdrawal.id, action: 'reject' })).status, 409);
  assert.strictEqual(await bal('bob'), start);                                 // não devolve duas vezes
});

test('saque: recusa, conta sem saldo, falha, devolução e resposta incerta', async () => {
  await user('hank'); await topup('hank', 5000);
  const start = await bal('hank');
  const ask = () => call('hank', 'POST', 'wallet/withdraw', { amount: 1500, keyType: 'TELEFONE', key: '(11) 91234-5678', ...PW });
  const approve = (id) => call('adm', 'POST', 'admin/wallet/withdraw', { id, action: 'approve', password: 'senha-forte-1' });
  const done = async (ref, state) => { mp.wd.get(ref).state = state; await send({ transactionId: ref, transactionType: 'RETIRADA', status: state }); };
  const last = async () => (await call('hank', 'GET', 'wallet')).body.withdrawals[0].status;
  const lastRef = () => [...mp.wd.keys()].pop();

  mp.withdrawStatus = 400; mp.withdrawCode = 'PIX_KEY_TYPE_INVALID';           // dados recusados: devolve na hora
  let w = (await ask()).body.withdrawal;
  assert.strictEqual((await approve(w.id)).body.withdrawal.status, 'falhou');
  assert.strictEqual(await bal('hank'), start);

  mp.withdrawCode = 'INSUFFICIENT_BALANCE'; mp.withdrawExtra = { details: { missingAmount: 12.5 } };   // a conta da LOJA está sem saldo
  w = (await ask()).body.withdrawal;
  const noBal = await approve(w.id);
  assert.strictEqual(noBal.status, 409);
  assert.match(noBal.body.error, /sem saldo.*12,50/);
  assert.strictEqual(await last(), 'pendente');                                // não devolve nem perde: segue na fila do admin
  assert.strictEqual(await bal('hank'), start - 1500);
  mp.withdrawStatus = 200; mp.withdrawExtra = null;                            // adicionou saldo na MisticPay e aprovou de novo
  assert.strictEqual((await approve(w.id)).body.withdrawal.status, 'enviando');
  await done(lastRef(), 'FALHA');                                              // a MisticPay não conseguiu enviar
  assert.strictEqual(await last(), 'falhou');
  assert.strictEqual(await bal('hank'), start);
  await done(lastRef(), 'FALHA');                                              // webhook repetido não devolve de novo
  assert.strictEqual(await bal('hank'), start);

  mp.withdrawStatus = 500; mp.withdrawCode = 'INTERNAL_ERROR';                 // pode ou não ter chegado lá
  w = (await ask()).body.withdrawal;
  assert.strictEqual((await approve(w.id)).body.withdrawal.status, 'verificar');
  assert.strictEqual(await bal('hank'), start - 1500);
  assert.strictEqual(await last(), 'enviando');                                // o cliente vê "processando"
  mp.withdrawStatus = 200;
  const n = mp.withdraws.length;
  assert.strictEqual((await approve(w.id)).body.withdrawal.status, 'enviando');    // aprovar de novo é seguro (mesma chave)
  assert.strictEqual(mp.withdraws.length, n + 1);
  const again = mp.calls.filter((x) => x.path === '/transactions/withdraw').map((x) => x.headers['X-Idempotency-Key']).filter((k) => k === `carteira-saque-${w.id}`);
  assert.strictEqual(again.length, 2);                                         // as duas tentativas usaram a mesma chave
  const f0 = (await walletTotals()).fees;
  await done(lastRef(), 'COMPLETO');
  assert.strictEqual(await last(), 'enviado');
  assert.ok((await walletTotals()).fees > f0);
  await done(lastRef(), 'DEVOLVIDO');                                          // o banco de destino devolveu
  assert.strictEqual(await last(), 'falhou');
  assert.strictEqual(await bal('hank'), start);
  assert.strictEqual((await walletTotals()).fees, f0);                         // a taxa foi desfeita

  mp.down = true;                                                              // rede caiu no meio
  w = (await ask()).body.withdrawal;
  assert.strictEqual((await approve(w.id)).body.withdrawal.status, 'verificar');
  mp.down = false;
  assert.strictEqual((await call('adm', 'POST', 'admin/wallet/withdraw', { id: w.id, action: 'sent', password: 'senha-forte-1' })).body.withdrawal.status, 'enviado');
  assert.strictEqual(await bal('hank'), start - 1500);
});

test('saque: limite diário e modo automático', async () => {
  await user('erin');
  await topup('erin', 500000); await topup('erin', 500000);                    // R$ 10.000
  const ask = (amount) => call('erin', 'POST', 'wallet/withdraw', { amount, keyType: 'CPF', key: CPF, ...PW });
  assert.strictEqual((await ask(150000)).status, 200);
  assert.strictEqual((await ask(60000)).status, 429);                          // 1.500 + 600 > 2.000 por dia
  assert.strictEqual((await ask(50000)).status, 200);

  let cfg = (await call('adm', 'GET', 'admin/settings')).body.config;
  cfg.wallet.withdrawMode = 'auto'; cfg.wallet.dailyWithdrawMax = 0;
  assert.strictEqual((await call('adm', 'POST', 'admin/settings/save', { wallet: cfg.wallet })).status, 200);
  const n0 = mp.withdraws.length, r = await ask(2000);
  assert.strictEqual(r.body.withdrawal.status, 'enviando');                    // sem passar pelo admin
  assert.strictEqual(mp.withdraws.length, n0 + 1);
  mp.withdrawStatus = 400; mp.withdrawCode = 'INSUFFICIENT_BALANCE';           // automático e a MisticPay sem saldo: o pedido não se perde
  const stuck = await ask(2000);
  assert.strictEqual(stuck.status, 200);
  assert.strictEqual(stuck.body.withdrawal.status, 'pendente');
  mp.withdrawStatus = 200;
  cfg.wallet.withdrawMode = 'manual';
  await call('adm', 'POST', 'admin/settings/save', { wallet: cfg.wallet });
});

test('tarifas configuráveis no painel e regras de validação das tarifas', async () => {
  const cfg = (await call('adm', 'GET', 'admin/settings')).body.config;
  assert.deepStrictEqual([cfg.wallet.transferFee, cfg.wallet.receiveFee, cfg.wallet.withdrawPct, cfg.wallet.withdrawFixed], [50, 50, 5, 50]);
  assert.strictEqual((await call('cli', 'GET', 'bootstrap')).body.config.wallet.transferFee, 50);   // o site mostra as tarifas
  assert.strictEqual((await call('adm', 'POST', 'admin/settings/save', { wallet: { ...cfg.wallet, receiveFee: 500, minTransfer: 100 } })).status, 400);
  assert.strictEqual((await call('bob', 'POST', 'admin/settings/save', { wallet: cfg.wallet })).status, 403);
  await call('adm', 'POST', 'admin/settings/save', { wallet: { ...cfg.wallet, transferFee: 100, withdrawPct: '2,5' } });
  const t = await call('bob', 'POST', 'wallet/transfer', { to: 'dave@teste.com', amount: 1000, ...PW });
  assert.strictEqual(t.body.transfer.charged, 1100);
  await call('adm', 'POST', 'admin/settings/save', { wallet: cfg.wallet });
  assert.strictEqual((await call('adm', 'GET', 'admin/settings')).body.config.wallet.withdrawPct, 5);
});

test('API: chave com escopos, saldo, extrato, recarga, transferência e revogação', async () => {
  await user('frank'); await user('gina');
  await topup('frank', 10000);
  assert.strictEqual((await call('frank', 'POST', 'account/api/create', { name: 'Loja', scopes: ['leitura'] })).status, 403);   // pede senha
  assert.strictEqual((await call('frank', 'POST', 'account/api/create', { name: 'Loja', scopes: [], ...PW })).status, 400);
  const a = (await call('frank', 'POST', 'account/api/create', { name: 'Só leitura', scopes: ['leitura'], ...PW })).body;
  assert.match(a.secret, /^cdk_/);
  assert.ok(!JSON.stringify(a.keys).includes(a.secret));                        // o segredo só aparece na criação
  const list = (await call('frank', 'GET', 'account/api')).body.keys;
  assert.ok(!JSON.stringify(list).includes(a.secret) && !JSON.stringify(list).includes('hash'));

  const s = await call('x', 'GET', 'v1/saldo', null, '', a.secret);
  assert.deepStrictEqual([s.status, s.body.saldo, s.body.saldo_centavos], [200, 100, 10000]);
  const e = await call('x', 'GET', 'v1/extrato', null, '', a.secret);
  assert.strictEqual(e.body.movimentos[0].tipo, 'recarga');
  assert.strictEqual(e.body.movimentos[0].valor, 100);
  assert.strictEqual((await call('x', 'POST', 'v1/transferir', { para: 'gina@teste.com', valor: 10 }, '', a.secret)).status, 403);   // sem escopo
  assert.strictEqual((await call('x', 'POST', 'v1/recarga', { valor: 10, cpf: CPF }, '', a.secret)).status, 403);
  assert.strictEqual((await call('x', 'GET', 'v1/saldo', null, '', 'cdk_chave-invalida-chave-invalida')).status, 401);
  assert.strictEqual((await call('x', 'GET', 'v1/saldo')).status, 401);        // sem chave
  assert.strictEqual((await call('x', 'GET', 'v1/saldo', null, '', 'lixo')).status, 401);

  const b = (await call('frank', 'POST', 'account/api/create', { name: 'Completa', scopes: ['leitura', 'recarga', 'transferencia'], ...PW })).body;
  const t = await call('x', 'POST', 'v1/transferir', { para: 'gina@teste.com', valor: '10,00', nota: 'via api' }, '', b.secret);
  assert.strictEqual(t.status, 200, JSON.stringify(t.body));
  assert.deepStrictEqual([t.body.transferencia.total_debitado, t.body.transferencia.valor_recebido, t.body.transferencia.saldo], [10.5, 9.5, 89.5]);
  assert.strictEqual(await bal('gina'), 950);
  assert.strictEqual((await call('x', 'POST', 'v1/transferir', { para: 'gina@teste.com', valor: 5000 }, '', b.secret)).status, 402);
  const rc = await call('x', 'POST', 'v1/recarga', { valor: 25.5, cpf: CPF }, '', b.secret);
  assert.strictEqual(rc.status, 200, JSON.stringify(rc.body));
  assert.strictEqual(rc.body.recarga.valor, 25.5);
  assert.ok(rc.body.recarga.pix_copia_e_cola);
  mp.charges.get(rc.body.recarga.id).state = 'COMPLETO';
  assert.strictEqual((await call('x', 'GET', 'v1/recarga', null, '&id=' + rc.body.recarga.id, b.secret)).body.recarga.status, 'pago');
  assert.strictEqual(await bal('frank'), 8950 + 2550);

  const keys = (await call('frank', 'POST', 'account/api/revoke', { id: a.keys[0].id })).body.keys;
  assert.strictEqual(keys.length, 1);
  assert.strictEqual((await call('x', 'GET', 'v1/saldo', null, '', a.secret)).status, 401);   // revogada
  assert.strictEqual((await call('x', 'GET', 'v1/saldo', null, '', b.secret)).status, 200);   // a outra segue valendo
  assert.strictEqual((await call('gina', 'POST', 'account/api/revoke', { id: keys[0].id })).status, 404);   // não revoga chave alheia
});

test('API: dono banido perde o acesso e a API pode ser desligada no painel', async () => {
  const k = (await call('gina', 'POST', 'account/api/create', { name: 'g', scopes: ['leitura'], ...PW })).body;
  assert.strictEqual((await call('x', 'GET', 'v1/saldo', null, '', k.secret)).status, 200);
  const cfg = (await call('adm', 'GET', 'admin/settings')).body.config;
  await call('adm', 'POST', 'admin/settings/save', { wallet: { ...cfg.wallet, apiEnabled: false } });
  assert.strictEqual((await call('x', 'GET', 'v1/saldo', null, '', k.secret)).status, 503);
  await call('adm', 'POST', 'admin/settings/save', { wallet: cfg.wallet });
  const gid = (await call('adm', 'GET', 'admin/users', null, '&q=gina')).body.users[0].id;
  await call('adm', 'POST', 'admin/user', { id: gid, action: 'ban', reason: 'teste' });
  assert.strictEqual((await call('x', 'GET', 'v1/saldo', null, '', k.secret)).status, 401);
  await call('adm', 'POST', 'admin/user', { id: gid, action: 'unban' });
});

test('admin: ajuste manual exige motivo e senha, aparece no extrato; conta com saldo não é apagada', async () => {
  const rr = require('../lib/redis');                                          // o painel limita confirmações de senha; o teste já usou várias
  const [, lim] = await rr.cmd(['SCAN', '0', 'MATCH', 'cd:rl:wsec:*', 'COUNT', 500]);
  if (lim.length) await rr.cmd(['DEL', ...lim]);
  const id = (await call('adm', 'GET', 'admin/users', null, '&q=dave')).body.users[0].id;
  const adj = (b) => call('adm', 'POST', 'admin/wallet/adjust', { userId: id, kind: 'credit', amount: 1000, reason: 'bônus', password: 'senha-forte-1', ...b });
  assert.strictEqual((await adj({ reason: '' })).status, 400);
  assert.strictEqual((await adj({ password: '' })).status, 403);
  assert.strictEqual((await adj({ amount: 0 })).status, 400);
  assert.strictEqual((await call('bob', 'POST', 'admin/wallet/adjust', { userId: id, kind: 'credit', amount: 1000, reason: 'x', ...PW })).status, 403);
  const before = await bal('dave');
  assert.strictEqual((await adj({})).body.balance, before + 1000);
  assert.strictEqual((await adj({ kind: 'debit', amount: 400, reason: 'correção' })).body.balance, before + 600);
  assert.strictEqual((await adj({ kind: 'debit', amount: 99999999 })).status, 402);
  const led = (await call('dave', 'GET', 'wallet')).body.ledger;
  assert.deepStrictEqual([led[0].type, led[0].amount], ['ajuste', -400]);
  assert.match(led[0].desc, /correção/);

  const u = (await call('adm', 'GET', 'admin/wallet/user', null, '&id=' + id)).body;
  assert.strictEqual(u.balance, before + 600);
  const found = (await call('adm', 'GET', 'admin/wallet/search', null, '&q=dave')).body.users;
  assert.strictEqual(found[0].balance, before + 600);
  assert.strictEqual((await call('adm', 'POST', 'admin/user', { id, action: 'delete' })).status, 409);   // tem saldo
  assert.strictEqual((await adj({ kind: 'debit', amount: before + 600, reason: 'zerar para apagar' })).status, 200);
  assert.strictEqual((await call('adm', 'POST', 'admin/user', { id, action: 'delete' })).status, 200);
});

test('extrato: paginação, CSV e quem não é o dono não vê o saldo dos outros', async () => {
  const w = (await call('alice', 'GET', 'wallet')).body;
  assert.ok(w.ledger.length > 3);
  assert.ok(w.ledger.every((x, i, a) => i === 0 || a[i - 1].at >= x.at));
  const csv = await call('alice', 'GET', 'wallet/export');
  assert.match(csv.body, /Data;Tipo;Descrição;Valor;Taxa;Saldo depois/);
  assert.match(csv.body, /recarga/);
  assert.strictEqual((await call('anon', 'GET', 'wallet')).status, 401);
  assert.strictEqual((await call('anon', 'GET', 'wallet/export')).status, 401);
});

test('conservação: tudo que entrou nas carteiras está nos saldos, na loja (compras e taxas) ou saiu por saque', async () => {
  const r = require('../lib/redis');
  // todos os extratos (inclui o de contas já apagadas)
  const [, keys] = await r.cmd(['SCAN', '0', 'MATCH', 'cd:wl:*', 'COUNT', 500]);
  const rows = [];
  for (const k of keys) rows.push(...(await r.cmd(['LRANGE', k, 0, 999])).map((x) => JSON.parse(x)));
  const sum = (f) => rows.filter(f).reduce((s, e) => s + e.amount, 0);
  const deposits = sum((e) => e.type === 'recarga');
  const adjusts = sum((e) => e.type === 'ajuste');                                       // créditos (+) e débitos (-)
  const purchases = -sum((e) => e.type === 'compra') - sum((e) => e.type === 'estorno' && /Reembolso do pedido/.test(e.desc));
  const t = await walletTotals(), wd = (await call('adm', 'GET', 'admin/wallet')).body;
  const sentFees = wd.recent.filter((x) => x.status === 'enviado').reduce((s, x) => s + x.fee, 0);
  const transferFees = t.fees - sentFees;
  const out = wd.totals.sentAmount + wd.totals.pendingAmount;                            // saques enviados e os que aguardam (já saíram do saldo)
  assert.ok(deposits > 0 && wd.totals.sent > 0 && wd.totals.pending > 0);
  assert.strictEqual(deposits + adjusts, t.total + purchases + transferFees + out, JSON.stringify({ deposits, adjusts, purchases, total: t.total, transferFees, out }));
});
