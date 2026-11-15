'use strict';
// Carteira da loja: saldo em centavos, extrato, recarga por PIX (MisticPay), compras com saldo,
// transferências entre contas, saques por PIX e chaves de API. Tudo no Redis, prefixo "cd:w*".
//
// Regras de dinheiro (todas configuráveis em Painel > Configurações > Carteira):
//   - Transferir: quem envia paga o valor + taxa de envio; quem recebe leva o valor - taxa de recebimento.
//   - Sacar: taxa = % do valor + taxa fixa. O valor pedido sai do saldo; no PIX chega o valor menos a taxa.
//   - Recarregar: sem taxa por padrão.
// O saldo é um inteiro no Redis alterado só com INCRBY/DECRBY (atômico). Nunca se grava o saldo lendo e regravando.
const crypto = require('crypto');
const r = require('./redis');
const MP = require('./misticpay');
const { fail, str, int, now, brl, isCpf, digits, isEmail, cleanEmail, shortName, csvCell } = require('./util');
const { notify } = require('./notify');
const shop = () => require('./shop');      // carregado só quando precisa (shop.js também usa a carteira)

const K = {
  bal: (u) => `cd:w:${u}`, led: (u) => `cd:wl:${u}`,
  dep: (i) => `cd:wd:${i}`, depUser: (u) => `cd:wdu:${u}`, depPend: 'cd:wdp', depRef: (t) => `cd:wdr:${t}`, depDone: (i) => `cd:wdc:${i}`,
  wd: (i) => `cd:ww:${i}`, wdRef: (t) => `cd:wwr:${t}`, wdAll: 'cd:wwl', wdUser: (u) => `cd:wwu:${u}`, wdPend: 'cd:wwp', wdDay: (u, d) => `cd:wwd:${u}:${d}`,
  fees: 'cd:wfees', keys: (u) => `cd:aku:${u}`, key: (h) => `cd:ak:${h}`,
  lock: (i) => `cd:plock:w:${i}`, chk: (i) => `cd:pchk:w:${i}`,        // prefixos "plock" e "pchk" ficam fora do backup
};
const newId = () => crypto.randomBytes(7).toString('hex');
const parse = (s) => { try { return JSON.parse(s); } catch (_) { return null; } };
const getJ = async (k) => { const v = await r.cmd(['GET', k]); return v ? parse(v) : null; };
const setJ = (k, o) => r.cmd(['SET', k, JSON.stringify(o)]);
const mgetJ = async (keys) => {
  const out = [];
  for (let i = 0; i < keys.length; i += 300) out.push(...(await r.cmd(['MGET', ...keys.slice(i, i + 300)])).map((x) => (x ? parse(x) : null)));
  return out;
};
const cfgW = async () => (await shop().getCfg()).wallet;
const dayKey = (t = now()) => new Date(t - 3 * 3600e3).toISOString().slice(0, 10);
const hist = (o, by, what) => { (o.history = o.history || []).push({ at: now(), by: by ? by.email || by : 'sistema', what }); };
const maskEmail = (e) => { const [a, b] = String(e).split('@'); return b ? `${a.slice(0, 1)}***@${b}` : '***'; };

/* ---------- Saldo e extrato ---------- */
const balance = async (u) => Number(await r.cmd(['GET', K.bal(u)])) || 0;
async function entry(u, e, bal) {
  const row = { id: newId(), at: now(), fee: 0, ...e, balance: bal };
  await r.cmd(['LPUSH', K.led(u), JSON.stringify(row)]);
  await r.cmd(['LTRIM', K.led(u), 0, 999]);
  return row;
}
// Soma ao saldo. e = { type, desc, fee?, gross?, ref?, who?, note? }. Devolve o saldo novo.
async function credit(u, cents, e) {
  cents = int(cents, 0, 1, 1e10);
  const bal = Number(await r.cmd(['INCRBY', K.bal(u), cents]));
  await entry(u, { ...e, amount: cents }, bal);
  return bal;
}
// Tira do saldo, sem deixar ficar negativo (se der negativo, desfaz e recusa).
async function debit(u, cents, e) {
  cents = int(cents, 0, 1, 1e10);
  const bal = Number(await r.cmd(['DECRBY', K.bal(u), cents]));
  if (bal < 0) { await r.cmd(['INCRBY', K.bal(u), cents]); fail(402, `Saldo insuficiente. Você tem ${brl(bal + cents)} na carteira.`); }
  await entry(u, { ...e, amount: -cents }, bal);
  return bal;
}
async function ledgerPage(u, page = 0) {
  const n = 30, rows = (await r.cmd(['LRANGE', K.led(u), page * n, page * n + n - 1])).map(parse).filter(Boolean);
  const total = Number(await r.cmd(['LLEN', K.led(u)])) || 0;
  return { rows, more: total > (page + 1) * n };
}
async function ledgerCsv(u) {
  const rows = (await r.cmd(['LRANGE', K.led(u), 0, 999])).map(parse).filter(Boolean);
  const money = (v) => (v / 100).toFixed(2).replace('.', ','), brt = (t) => new Date(t - 3 * 3600e3).toISOString().slice(0, 16).replace('T', ' ');
  return { head: ['Data', 'Tipo', 'Descrição', 'Valor', 'Taxa', 'Saldo depois'], rows: rows.map((x) => [brt(x.at), x.type, x.desc, money(x.amount), money(x.fee || 0), money(x.balance)]) };
}

/* ---------- Recarga por PIX ---------- */
const depView = (d) => d && ({
  id: d.id, amount: d.amount, fee: d.fee || 0, credited: d.amount - (d.fee || 0), status: d.status, createdAt: d.createdAt, expiresAt: d.expiresAt, paidAt: d.paidAt || 0,
  pay: d.status === 'pendente' && d.pay ? { copyPaste: d.pay.copyPaste, qr: d.pay.qr || '' } : null,
});
async function createDeposit(user, i, ctx = {}) {
  const w = await cfgW();
  if (!w.enabled) fail(503, 'A carteira está desativada no momento.');
  const amount = int(i.amount, 0, 0, 1e10);
  if (amount < w.minDeposit) fail(400, `A recarga mínima é ${brl(w.minDeposit)}.`);
  if (amount > w.maxDeposit) fail(400, `A recarga máxima é ${brl(w.maxDeposit)}.`);
  if (amount <= (w.depositFee || 0)) fail(400, 'O valor precisa ser maior que a taxa de recarga.');
  const cpf = digits(i.cpf);
  if (!isCpf(cpf)) fail(400, 'Informe um CPF válido para gerar o PIX.');
  if (!MP.configured()) { const e = new Error('MISTICPAY_CLIENT_ID e MISTICPAY_CLIENT_SECRET não configurados'); e.setup = true; throw e; }
  const open = (await listDeposits(user.id, false)).filter((d) => d.status === 'pendente').length;
  if (open >= 5) fail(429, 'Você já tem 5 recargas aguardando pagamento. Pague ou cancele alguma antes de gerar outra.');
  const d = { id: 'rc' + newId(), userId: user.id, userName: user.name, amount, fee: w.depositFee || 0, status: 'pendente', createdAt: now(), expiresAt: now() + 3600e3 };
  const ch = await MP.createCharge({ amountCents: amount, orderId: d.id, payerName: str(user.name, 60), payerDocument: cpf, description: `Recarga de carteira - ${str(user.name, 40)}`.slice(0, 120), webhookUrl: ctx.webhookUrl });
  d.pay = { provider: 'misticpay', txId: ch.txId, copyPaste: ch.copyPaste, qr: ch.qr };
  await setJ(K.dep(d.id), d);
  await r.cmd(['LPUSH', K.depUser(user.id), d.id]);
  await r.cmd(['LTRIM', K.depUser(user.id), 0, 99]);
  await r.cmd(['SADD', K.depPend, d.id]);
  await r.cmd(['SET', K.depRef(ch.txId), d.id, 'EX', 60 * 86400]);
  return depView(d);
}
async function findDepositByRef(ref) {
  ref = str(ref, 80);
  if (!ref) return null;
  if (/^rc[0-9a-f]{14}$/.test(ref)) { const d = await getJ(K.dep(ref)); if (d) return d; }
  const id = await r.cmd(['GET', K.depRef(ref)]);
  return id ? getJ(K.dep(id)) : null;
}
// Confere o pagamento direto na MisticPay (nunca confia no aviso do webhook) e credita UMA vez.
// Vale também para recarga expirada ou cancelada: se o PIX foi pago, o dinheiro entrou de verdade.
async function confirmDeposit(d0) {
  const OPENS = ['pendente', 'expirado', 'cancelado'];
  if (!d0 || !d0.pay || !OPENS.includes(d0.status) || d0.issue) return d0;
  if ((await r.cmd(['SET', K.lock(d0.id), '1', 'NX', 'EX', 30])) === null) return d0;
  try {
    const d = await getJ(K.dep(d0.id));
    if (!d || !OPENS.includes(d.status) || d.issue) return d || d0;
    const tx = await MP.checkCharge(d.id, d.pay.txId);
    if (tx.state !== 'COMPLETO' || (tx.type && tx.type !== 'DEPOSITO')) return d;
    if (!(tx.valueCents >= d.amount - 1)) return noteDepositIssue(d, `Valor pago (${brl(tx.valueCents)}) menor que o da recarga (${brl(d.amount)}). Confira no painel da MisticPay.`);
    if ((await r.cmd(['SET', K.depDone(d.id), '1', 'NX'])) === null) return d;       // já creditada
    const net = d.amount - (d.fee || 0);
    await credit(d.userId, net, { type: 'recarga', fee: d.fee || 0, gross: d.amount, desc: 'Recarga por PIX', ref: d.id });
    if (d.fee) await r.cmd(['INCRBY', K.fees, d.fee]);
    d.status = 'pago'; d.paidAt = now();
    await setJ(K.dep(d.id), d);
    await r.cmd(['SREM', K.depPend, d.id]);
    await shop().audit('sistema', 'carteira:recarga', `${d.userName} ${brl(net)}`);
    return d;
  } finally { await r.cmd(['DEL', K.lock(d0.id)]).catch(() => {}); }
}
async function noteDepositIssue(d, msg) {
  if (d.issue === msg) return d;
  d.issue = msg; hist(d, 'MisticPay', msg);
  await setJ(K.dep(d.id), d);
  await shop().audit('sistema', 'carteira:atencao', `${d.id}: ${msg}`);
  await notify('attention', { title: 'Recarga da carteira precisa de atenção', text: msg, tone: 'bad', fields: [['Cliente', d.userName], ['Valor', brl(d.amount)]] });
  return d;
}
async function noteDepositRefund(d, info) {
  const st = String((info && info.status) || '').toUpperCase();
  return noteDepositIssue(d, `MisticPay: ${st === 'DEVOLVIDO_PARCIAL' ? 'reembolso parcial' : 'reembolso'} do PIX desta recarga. Confira o saldo do cliente e ajuste se for o caso.`);
}
async function refreshDeposit(d) {
  if (!d.pay || d.status !== 'pendente') return d;
  if ((await r.cmd(['SET', K.chk(d.id), '1', 'NX', 'EX', 6])) === null) return d;
  try { return await confirmDeposit(d); } catch (e) { console.error('[carteira]', String((e && e.message) || e)); return d; }
}
async function listDeposits(userId, refresh = true) {
  const ids = await r.cmd(['LRANGE', K.depUser(userId), 0, 29]);
  let list = (await mgetJ(ids.map(K.dep))).filter(Boolean);
  if (!refresh) return list;
  list = await Promise.all(list.map(async (d) => {
    if (d.status !== 'pendente') return d;
    d = await refreshDeposit(d);
    if (d.status === 'pendente' && d.expiresAt < now()) {            // venceu: última conferência e expira
      try { d = await confirmDeposit(d); } catch (_) { return d; }
      if (d.status === 'pendente') { d.status = 'expirado'; await setJ(K.dep(d.id), d); await r.cmd(['SREM', K.depPend, d.id]); }
    }
    return d;
  }));
  return list;
}
async function getDeposit(user, id) {
  const d = await getJ(K.dep(str(id, 40)));
  if (!d || d.userId !== user.id) fail(404, 'Recarga não encontrada.');
  return depView(await refreshDeposit(d));
}
async function cancelDeposit(user, id) {
  let d = await getJ(K.dep(str(id, 40)));
  if (!d || d.userId !== user.id) fail(404, 'Recarga não encontrada.');
  d = await confirmDeposit(d);
  if (d.status === 'pago') fail(409, 'Esse PIX já foi pago e o saldo entrou na sua carteira.');
  if (d.status !== 'pendente') fail(409, 'Essa recarga não está mais aguardando pagamento.');
  d.status = 'cancelado'; hist(d, user, 'Cancelada pelo cliente');
  await setJ(K.dep(d.id), d); await r.cmd(['SREM', K.depPend, d.id]);
  return depView(d);
}

/* ---------- Transferências ---------- */
async function lookup(user, email) {
  email = cleanEmail(email);
  if (!isEmail(email)) fail(400, 'Informe o e-mail do destinatário.');
  const S = shop(), id = await r.cmd(['GET', S.K.email(email)]), u = id ? await getJ(S.K.user(id)) : null;
  if (!u || u.banned) fail(404, 'Não encontramos uma conta com esse e-mail.');
  if (u.id === user.id) fail(400, 'Você não pode transferir para a sua própria conta.');
  return { id: u.id, name: shortName(u.name), email: maskEmail(u.email) };
}
async function transfer(user, i) {
  const w = await cfgW();
  if (!w.enabled) fail(503, 'A carteira está desativada no momento.');
  const to = await lookup(user, i.to), amount = int(i.amount, 0, 0, 1e10);
  if (amount < w.minTransfer) fail(400, `A transferência mínima é ${brl(w.minTransfer)}.`);
  const feeS = w.transferFee, feeR = w.receiveFee, pay = amount + feeS, recv = amount - feeR;
  if (recv <= 0) fail(400, 'O valor precisa ser maior que a taxa de recebimento.');
  const note = str(i.note, 80), id = newId(), me = shortName(user.name);
  const bal = await debit(user.id, pay, { type: 'envio', fee: feeS, gross: amount, desc: `Transferência para ${to.name}`, who: to.name, note, ref: id });
  try {
    await credit(to.id, recv, { type: 'recebido', fee: feeR, gross: amount, desc: `Transferência de ${me}`, who: me, note, ref: id });
  } catch (e) {
    await credit(user.id, pay, { type: 'estorno', desc: 'Estorno: a transferência não pôde ser concluída', ref: id }).catch(() => {});
    throw e;
  }
  await r.cmd(['INCRBY', K.fees, feeS + feeR]);
  return { id, amount, feeSent: feeS, feeReceived: feeR, charged: pay, received: recv, balance: bal, to: { name: to.name } };
}

/* ---------- Saques por PIX ---------- */
const isCnpj = (v) => {
  const c = digits(v);
  if (c.length !== 14 || /^(\d)\1{13}$/.test(c)) return false;
  const calc = (n) => { let s = 0, p = n - 7; for (let i = 0; i < n; i++) { s += Number(c[i]) * p--; if (p < 2) p = 9; } const m = s % 11; return m < 2 ? 0 : 11 - m; };
  return calc(12) === Number(c[12]) && calc(13) === Number(c[13]);
};
const KEY_TYPES = ['CPF', 'CNPJ', 'EMAIL', 'TELEFONE', 'CHAVE_ALEATORIA'];
function pixKey(type, raw) {
  type = String(type || '').toUpperCase(); raw = str(raw, 100);
  if (type === 'CPF') { const d = digits(raw); if (!isCpf(d)) fail(400, 'CPF da chave PIX inválido.'); return { type, key: d }; }
  if (type === 'CNPJ') { const d = digits(raw); if (!isCnpj(d)) fail(400, 'CNPJ da chave PIX inválido.'); return { type, key: d }; }
  if (type === 'EMAIL') { const e = cleanEmail(raw); if (!isEmail(e)) fail(400, 'E-mail da chave PIX inválido.'); return { type, key: e }; }
  if (type === 'TELEFONE') { let d = digits(raw); if (d.length >= 12 && d.startsWith('55')) d = d.slice(2); if (d.length < 10 || d.length > 11) fail(400, 'Telefone da chave PIX inválido. Use DDD + número.'); return { type, key: d }; }
  if (type === 'CHAVE_ALEATORIA') { const k = raw.toLowerCase(); if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(k)) fail(400, 'Chave aleatória inválida.'); return { type, key: k }; }
  return fail(400, 'Escolha o tipo da chave PIX.');
}
const maskKey = (type, key) => (type === 'EMAIL' ? maskEmail(key) : `••••${String(key).slice(-4)}`);
const withdrawFee = (amount, w) => Math.round(amount * w.withdrawPct / 100) + w.withdrawFixed;
const wdView = (x, admin) => x && ({
  id: x.id, amount: x.amount, fee: x.fee, net: x.net, keyType: x.keyType, key: admin ? x.key : maskKey(x.keyType, x.key),
  status: admin ? x.status : (x.status === 'verificar' ? 'enviando' : x.status),
  createdAt: x.createdAt, sentAt: x.sentAt || 0, reason: x.reason || '',
  ...(admin ? { userId: x.userId, userName: x.userName, userEmail: x.userEmail, history: x.history || [], by: x.by || '' } : {}),
});
async function requestWithdraw(user, i, ctx = {}) {
  const w = await cfgW();
  if (!w.enabled) fail(503, 'A carteira está desativada no momento.');
  const amount = int(i.amount, 0, 0, 1e10);
  if (amount < w.minWithdraw) fail(400, `O saque mínimo é ${brl(w.minWithdraw)}.`);
  const fee = withdrawFee(amount, w), net = amount - fee;
  if (net < 100) fail(400, 'O valor precisa ser maior que a taxa de saque.');
  const k = pixKey(i.keyType, i.key), day = K.wdDay(user.id, dayKey());
  const used = Number(await r.cmd(['INCRBY', day, amount]));
  await r.cmd(['EXPIRE', day, 3 * 86400]);
  const giveBack = () => r.cmd(['DECRBY', day, amount]).catch(() => {});
  if (w.dailyWithdrawMax && used > w.dailyWithdrawMax) { await giveBack(); fail(429, `O limite de saques por dia é ${brl(w.dailyWithdrawMax)}. Hoje você ainda pode sacar ${brl(Math.max(0, w.dailyWithdrawMax - (used - amount)))}.`); }
  const id = newId();
  try { await debit(user.id, amount, { type: 'saque', fee, gross: amount, desc: `Saque por PIX (${k.type === 'CHAVE_ALEATORIA' ? 'chave aleatória' : k.type.toLowerCase()})`, ref: id }); }
  catch (e) { await giveBack(); throw e; }
  const x = { id, userId: user.id, userName: user.name, userEmail: user.email, amount, fee, net, keyType: k.type, key: k.key, status: 'pendente', createdAt: now(), history: [] };
  hist(x, user, 'Saque solicitado');
  await setJ(K.wd(id), x);
  await r.cmd(['LPUSH', K.wdAll, id]); await r.cmd(['LTRIM', K.wdAll, 0, 1999]);
  await r.cmd(['LPUSH', K.wdUser(user.id), id]); await r.cmd(['LTRIM', K.wdUser(user.id), 0, 99]);
  await r.cmd(['SADD', K.wdPend, id]);
  await notify('withdraw', { title: 'Novo pedido de saque', text: w.withdrawMode === 'auto' ? 'Envio automático.' : 'Aguardando a sua aprovação em Painel > Carteiras.', tone: 'warn', fields: [['Cliente', user.name], ['Valor', brl(amount)], ['Líquido no PIX', brl(net)]] });
  if (w.withdrawMode !== 'auto') return x;
  try { return await sendWithdraw(x, 'sistema', ctx); }
  catch (e) {                                   // não perde o pedido: o valor já saiu do saldo, então fica pendente para o admin resolver
    await notify('attention', { title: 'Saque automático não saiu', text: String((e && e.message) || e).slice(0, 300), tone: 'bad', fields: [['Cliente', user.name], ['Valor', brl(amount)]] });
    return (await getJ(K.wd(x.id))) || x;
  }
}
async function returnWithdraw(x, status, why, by) {
  const day = K.wdDay(x.userId, dayKey(x.createdAt));
  await credit(x.userId, x.amount, { type: 'estorno', desc: `Estorno do saque: ${why}`, ref: x.id });
  await r.cmd(['DECRBY', day, x.amount]).catch(() => {});
  if (x.status === 'enviado') await r.cmd(['INCRBY', K.fees, -x.fee]);          // a taxa já contada deixa de valer
  x.status = status; x.reason = why; x.closedAt = now(); hist(x, by, `${status === 'recusado' ? 'Recusado' : 'Falhou'}: ${why}. Valor devolvido à carteira`);
  await setJ(K.wd(x.id), x); await r.cmd(['SREM', K.wdPend, x.id]);
  return x;
}
async function markSent(x, by, what) {
  x.status = 'enviado'; x.sentAt = now(); x.by = by ? by.email || by : 'sistema'; hist(x, by, what);
  await setJ(K.wd(x.id), x); await r.cmd(['SREM', K.wdPend, x.id]); await r.cmd(['INCRBY', K.fees, x.fee]);
  await shop().audit(by, 'carteira:saque-enviado', `${x.userName} ${brl(x.net)}`);
  return x;
}
// Pede o PIX à MisticPay. Ela responde que o saque entrou na FILA ("enviando"); o resultado final chega pelo webhook
// e é confirmado em confirmWithdraw. A chave de idempotência garante que repetir o pedido nunca gera dois PIX.
//   - recusa clara de dados (chave PIX inválida, valor...) -> devolve o saldo ao cliente
//   - conta MisticPay da loja sem saldo -> continua pendente, o admin adiciona saldo e aprova de novo
//   - erro de rede/5xx -> "verificar": aprovar de novo é seguro (mesma chave), ou marque enviado/estorne
async function sendWithdraw(x0, by, ctx = {}) {
  if (!['pendente', 'verificar'].includes(x0.status)) fail(409, 'Esse saque já foi tratado.');
  if ((await r.cmd(['SET', K.lock(x0.id), '1', 'NX', 'EX', 40])) === null) fail(409, 'Esse saque está sendo processado. Aguarde alguns segundos.');
  try {
    const x = await getJ(K.wd(x0.id));
    if (!x || !['pendente', 'verificar'].includes(x.status)) fail(409, 'Esse saque já foi tratado.');
    try {
      const out = await MP.createWithdraw({ amountCents: x.net, pixKey: x.key, pixKeyType: x.keyType, description: `Saque carteira ${x.id.slice(-6)}`, webhookUrl: ctx.webhookUrl, idempotencyKey: `carteira-saque-${x.id}` });
      x.status = 'enviando'; x.providerRef = out.ref; x.by = by ? by.email || by : 'sistema';
      hist(x, by, 'PIX entregue à MisticPay (na fila de processamento)');
      await setJ(K.wd(x.id), x);
      if (out.ref) await r.cmd(['SET', K.wdRef(out.ref), x.id, 'EX', 120 * 86400]);
      await shop().audit(by, 'carteira:saque-na-fila', `${x.userName} ${brl(x.net)}`);
      return x;
    } catch (e) {
      const up = e && e.upstream;
      if (e && e.setup) throw e;                                                 // credencial/escopo/IP: nada saiu, segue pendente
      if (up === 429) fail(429, 'A MisticPay pediu para aguardar. Tente de novo em instantes.');
      if (e && e.code === 'INSUFFICIENT_BALANCE') fail(409, `A conta MisticPay da loja está sem saldo para este saque${e.missingCents ? ` (faltam ${brl(e.missingCents)})` : ''}. Adicione saldo lá e aprove de novo.`);
      if (up && up >= 400 && up < 500) {
        const o = await returnWithdraw(x, 'falhou', `a MisticPay recusou (${e.code || up})`, 'sistema');
        await shop().audit(by, 'carteira:saque-falhou', `${x.userName} ${brl(x.amount)} ${e.code || up}`);
        return o;
      }
      x.status = 'verificar'; hist(x, 'sistema', 'Sem resposta clara da MisticPay. Aprovar de novo é seguro (não duplica o PIX); ou confira no painel deles');
      await setJ(K.wd(x.id), x);
      await notify('attention', { title: 'Saque precisa de conferência', text: 'A MisticPay não respondeu com clareza. Veja em Painel > Carteiras.', tone: 'bad', fields: [['Cliente', x.userName], ['Valor', brl(x.net)]] });
      return x;
    }
  } finally { await r.cmd(['DEL', K.lock(x0.id)]).catch(() => {}); }
}
async function findWithdrawByRef(ref) {
  ref = str(ref, 80);
  const id = ref ? await r.cmd(['GET', K.wdRef(ref)]) : null;
  return id ? getJ(K.wd(id)) : null;
}
// Confirma o resultado do saque na MisticPay (o corpo do webhook nunca é confiado) e fecha o pedido.
async function confirmWithdraw(x0) {
  if (!x0 || !x0.providerRef || !['enviando', 'verificar', 'enviado'].includes(x0.status)) return x0;
  if ((await r.cmd(['SET', K.lock(x0.id), '1', 'NX', 'EX', 30])) === null) return x0;
  try {
    const x = await getJ(K.wd(x0.id));
    if (!x || !['enviando', 'verificar', 'enviado'].includes(x.status)) return x || x0;
    const tx = await MP.checkWithdraw(x.providerRef);
    if (tx.type && tx.type !== 'RETIRADA') return x;
    if (tx.state === 'COMPLETO') return x.status === 'enviado' ? x : markSent(x, 'MisticPay', 'PIX concluído (confirmado na MisticPay)');
    if (tx.state === 'FALHA' || tx.state === 'CANCELADO') return x.status === 'enviado' ? x : returnWithdraw(x, 'falhou', 'a MisticPay não conseguiu enviar o PIX', 'MisticPay');
    if (tx.state === 'DEVOLVIDO') return returnWithdraw(x, 'falhou', 'o banco de destino devolveu o PIX', 'MisticPay');
    if (tx.state === 'DEVOLVIDO_PARCIAL') {
      const msg = 'PIX devolvido em parte pelo banco de destino. Ajuste o saldo do cliente em Carteiras, se for o caso.';
      if (x.issue !== msg) { x.issue = msg; hist(x, 'MisticPay', msg); await setJ(K.wd(x.id), x); await notify('attention', { title: 'Saque devolvido em parte', text: msg, tone: 'bad', fields: [['Cliente', x.userName], ['Valor', brl(x.net)]] }); }
    }
    return x;
  } finally { await r.cmd(['DEL', K.lock(x0.id)]).catch(() => {}); }
}
// Saque na fila há mais de 1 min sem aviso: pergunta à MisticPay (no máximo a cada 20 s por saque).
async function refreshWithdraw(x) {
  if (x.status !== 'enviando' || !x.providerRef) return x;
  if ((await r.cmd(['SET', K.chk(x.id), '1', 'NX', 'EX', 20])) === null) return x;
  try { return await confirmWithdraw(x); } catch (e) { console.error('[carteira]', String((e && e.message) || e)); return x; }
}
async function listWithdrawals(userId) {
  const ids = await r.cmd(['LRANGE', K.wdUser(userId), 0, 29]);
  return Promise.all((await mgetJ(ids.map(K.wd))).filter(Boolean).map(refreshWithdraw));
}

/* ---------- Visão do cliente ---------- */
async function overview(user, page = 0) {
  const [bal, led, deps, wds] = await Promise.all([balance(user.id), ledgerPage(user.id, page), listDeposits(user.id), listWithdrawals(user.id)]);
  return { balance: bal, ledger: led.rows, more: led.more, deposits: deps.slice(0, 10).map(depView), withdrawals: wds.slice(0, 10).map((x) => wdView(x, false)) };
}

/* ---------- Admin ---------- */
async function totals() {
  const ids = await r.cmd(['SMEMBERS', shop().K.users]);
  let total = 0, holders = 0;
  for (let i = 0; i < ids.length; i += 300) {
    for (const v of await r.cmd(['MGET', ...ids.slice(i, i + 300).map(K.bal)])) { const n = Number(v) || 0; if (n > 0) { total += n; holders++; } }
  }
  return { total, holders, fees: Number(await r.cmd(['GET', K.fees])) || 0 };
}
async function adminOverview() {
  const [t, ids, mistic] = await Promise.all([totals(), r.cmd(['LRANGE', K.wdAll, 0, 199]), MP.configured() ? MP.balance() : null]);
  const all = (await Promise.all((await mgetJ(ids.map(K.wd))).filter(Boolean).map(refreshWithdraw))).map((x) => wdView(x, true));
  const open = all.filter((x) => ['pendente', 'verificar', 'enviando'].includes(x.status));
  const sum = (a) => a.reduce((s, x) => s + x.amount, 0);
  return { totals: { ...t, mistic, pending: open.length, pendingAmount: sum(open), sent: all.filter((x) => x.status === 'enviado').length, sentAmount: sum(all.filter((x) => x.status === 'enviado')) }, open, recent: all.filter((x) => !open.includes(x)).slice(0, 50) };
}
async function adminSearch(q) {
  if (!q) return [];
  const us = (await shop().listUsers(q)).slice(0, 8);
  const bals = await r.pipe(us.map((u) => ['GET', K.bal(u.id)]));
  return us.map((u, i) => ({ id: u.id, name: u.name, email: u.email, balance: Number(bals[i]) || 0 }));
}
async function adminUser(id) {
  const S = shop(), u = await getJ(S.K.user(id)) || fail(404, 'Usuário não encontrado.');
  const [bal, led] = await Promise.all([balance(u.id), ledgerPage(u.id, 0)]);
  return { user: { id: u.id, name: u.name, email: u.email }, balance: bal, ledger: led.rows };
}
async function adjust(by, b) {
  const S = shop(), u = await getJ(S.K.user(str(b.userId, 40))) || fail(404, 'Usuário não encontrado.');
  const amount = int(b.amount, 0, 0, 1e10), reason = str(b.reason, 120);
  if (amount < 1) fail(400, 'Informe o valor do ajuste.');
  if (reason.length < 3) fail(400, 'Explique o motivo do ajuste (fica no extrato do cliente e no registro de ações).');
  const e = { type: 'ajuste', desc: `Ajuste da loja: ${reason}`, ref: 'admin' };
  const bal = b.kind === 'debit' ? await debit(u.id, amount, e) : await credit(u.id, amount, e);
  await S.audit(by, b.kind === 'debit' ? 'carteira:ajuste-debito' : 'carteira:ajuste-credito', `${u.email} ${brl(amount)} · ${reason}`);
  return { balance: bal };
}
async function adminWithdrawAction(by, b, ctx = {}) {
  const x = await getJ(K.wd(str(b.id, 40))) || fail(404, 'Saque não encontrado.');
  const reason = str(b.reason, 120);
  switch (b.action) {
    case 'approve': return wdView(await sendWithdraw(x, by, ctx), true);
    case 'check': return wdView(await confirmWithdraw(x), true);          // pergunta à MisticPay como está o saque na fila
    case 'reject':
      if (x.status !== 'pendente') fail(409, 'Só dá para recusar saques pendentes.');
      return wdView(await returnWithdraw(x, 'recusado', reason || 'recusado pela loja', by), true);
    case 'sent':        // conferiu na MisticPay que o PIX saiu
      if (x.status !== 'verificar') fail(409, 'Esse saque não está em conferência.');
      return wdView(await markSent(x, by, 'Marcado como enviado (conferido na MisticPay)'), true);
    case 'refund':      // conferiu que o PIX NÃO saiu
      if (x.status !== 'verificar') fail(409, 'Esse saque não está em conferência.');
      await shop().audit(by, 'carteira:saque-estornado', `${x.userName} ${brl(x.amount)}`);
      return wdView(await returnWithdraw(x, 'falhou', reason || 'PIX não saiu', by), true);
    default: return fail(400, 'Ação desconhecida.');
  }
}

/* ---------- Chaves de API ---------- */
const SCOPES = { leitura: 'Ver saldo e extrato', recarga: 'Gerar recargas por PIX', transferencia: 'Transferir saldo para outras contas' };
const hashKey = (s) => crypto.createHash('sha256').update(s).digest('hex');
const keyView = (k) => ({ id: k.id, name: k.name, scopes: k.scopes, prefix: k.prefix, createdAt: k.createdAt, lastUsed: k.lastUsed || 0 });
const listKeys = async (u) => (await getJ(K.keys(u))) || [];
const listKeysView = async (u) => (await listKeys(u)).map(keyView);
async function createKey(user, b) {
  const keys = await listKeys(user.id);
  if (keys.length >= 5) fail(409, 'Você já tem 5 chaves. Revogue alguma para criar outra.');
  const scopes = [...new Set((Array.isArray(b.scopes) ? b.scopes : []).filter((s) => SCOPES[s]))];
  if (!scopes.length) fail(400, 'Marque pelo menos uma permissão para a chave.');
  const secret = 'cdk_' + crypto.randomBytes(24).toString('base64url'), hash = hashKey(secret), id = newId();
  keys.push({ id, name: str(b.name, 40) || 'Minha chave', scopes, prefix: secret.slice(0, 10), hash, createdAt: now(), lastUsed: 0 });
  await setJ(K.keys(user.id), keys);
  await r.cmd(['SET', K.key(hash), `${user.id}:${id}`]);
  return { secret, keys: keys.map(keyView) };
}
async function revokeKey(userId, id) {
  const keys = await listKeys(userId), k = keys.find((x) => x.id === str(id, 40));
  if (!k) fail(404, 'Chave não encontrada.');
  await setJ(K.keys(userId), keys.filter((x) => x !== k));
  await r.cmd(['DEL', K.key(k.hash)]);
  return keys.filter((x) => x !== k).map(keyView);
}
// Acha o dono da chave. Devolve { user, key } ou null (chave inexistente, revogada ou dono banido/apagado).
async function authKey(token) {
  if (!/^cdk_[\w-]{20,80}$/.test(String(token || ''))) return null;
  const hash = hashKey(token), ref = await r.cmd(['GET', K.key(hash)]);
  if (!ref) return null;
  const [uid, kid] = String(ref).split(':'), keys = await listKeys(uid), key = keys.find((x) => x.id === kid && x.hash === hash);
  if (!key) return null;
  const user = await getJ(shop().K.user(uid));
  if (!user || user.banned) return null;
  if (now() - (key.lastUsed || 0) > 600e3) {                                  // marca o último uso, no máximo a cada 10 min
    const fresh = await listKeys(uid), f = fresh.find((x) => x.id === kid);
    if (f) { f.lastUsed = now(); await setJ(K.keys(uid), fresh); }
  }
  return { user, key };
}

module.exports = {
  K, KEY_TYPES, SCOPES, balance, credit, debit, ledgerPage, ledgerCsv, createDeposit, getDeposit, cancelDeposit, confirmDeposit, findDepositByRef, noteDepositIssue, noteDepositRefund,
  lookup, transfer, requestWithdraw, findWithdrawByRef, confirmWithdraw, withdrawFee, wdView, pixKey, isCnpj, overview, adminOverview, adminSearch, adminUser, adjust, adminWithdrawAction,
  listKeysView, createKey, revokeKey, authKey, csvCell,
};
