'use strict';
// Suporte: tickets (com ou sem pedido) e pedidos de reposição dentro da garantia.
const crypto = require('crypto');
const r = require('./redis');
const S = require('./shop');
const { fail, str, int, now } = require('./util');
const { notify } = require('./notify');

const K = { tk: (id) => `cd:tk:${id}`, all: 'cd:tks', user: (uid) => `cd:utk:${uid}` };
const getTicket = async (id) => (await S.getJ(K.tk(str(id, 40)))) || fail(404, 'Ticket não encontrado.');
const save = (t) => { t.updatedAt = now(); return S.setJ(K.tk(t.id), t); };
const summary = (t) => { const last = t.messages[t.messages.length - 1] || {}; return { id: t.id, code: t.code, type: t.type, subject: t.subject, status: t.status, orderCode: t.orderCode, userName: t.userName, resolution: t.resolution || '', updatedAt: t.updatedAt, createdAt: t.createdAt, count: t.messages.length, preview: str(last.text, 90), lastBy: last.by }; };

async function create(user, b) {
  const type = b.type === 'reposicao' ? 'reposicao' : 'suporte';
  const text = str(b.text, 2000);
  if (text.length < 5) fail(400, 'Descreva o problema com pelo menos 5 caracteres.');
  let order = null, line = 0, ref = null;
  if (b.orderId) {
    order = await S.getOrder(b.orderId);
    if (order.userId !== user.id) fail(404, 'Pedido não encontrado.');
    line = int(b.line, 0, 0, order.lines.length - 1);
  }
  if (type === 'reposicao') {
    if (!order) fail(400, 'Escolha o pedido.');
    if (!['pago', 'entregue'].includes(order.status)) fail(409, 'Só dá para pedir reposição de pedidos pagos.');
    const l = order.lines[line];
    if (!l.delivered) fail(409, 'Esse item ainda não foi entregue.');
    if (!l.warrantyUntil || now() > l.warrantyUntil) fail(409, 'A garantia deste item acabou (ou o produto não tem garantia). Abra um ticket de suporte.');
    if (l.replaceTicket) { const t0 = await S.getJ(K.tk(l.replaceTicket)); if (t0 && t0.status !== 'fechado') fail(409, 'Já existe um pedido de reposição aberto para este item.'); }
    const mine = l.delivered.type === 'items' ? l.delivered.items : [];
    ref = { orderId: order.id, line, items: (Array.isArray(b.items) ? b.items : []).map((x) => str(x, 2000)).filter((x) => mine.includes(x)).slice(0, l.qty) };
  }
  const t = {
    id: S.newId(), code: 'TK-' + crypto.randomBytes(3).toString('hex').toUpperCase(), type, userId: user.id, userName: user.name,
    subject: str(b.subject, 120) || (type === 'reposicao' ? `Reposição: ${order.lines[line].name}` : order ? `Pedido ${order.code}` : 'Suporte'),
    orderId: order ? order.id : '', orderCode: order ? order.code : '', line: order ? line : -1, ref, status: 'aberto',
    messages: [{ by: 'cliente', name: user.name, text, at: now() }], createdAt: now(), updatedAt: now(),
  };
  await save(t);
  await r.cmd(['LPUSH', K.all, t.id]); await r.cmd(['LPUSH', K.user(user.id), t.id]);
  if (type === 'reposicao') { order.lines[line].replaceTicket = t.id; S.hist(order, user, `Pedido de reposição aberto (${t.code})`); await S.saveOrder(order); }
  await notify('ticket', { title: `${type === 'reposicao' ? 'Reposição' : 'Novo ticket'} ${t.code}`, text, tone: type === 'reposicao' ? 'warn' : 'info', fields: [['Cliente', user.name], ['Pedido', t.orderCode || '—']] });
  return t;
}
async function reply(who, id, text, asAdmin) {
  const t = await getTicket(id);
  if (!asAdmin && t.userId !== who.id) fail(404, 'Ticket não encontrado.');
  text = str(text, 2000);
  if (text.length < 2) fail(400, 'Escreva a mensagem.');
  if (t.messages.length >= 200) fail(409, 'Este ticket está muito longo. Abra um novo.');
  t.messages.push({ by: asAdmin ? 'admin' : 'cliente', name: who.name, text, at: now() });
  if (!asAdmin) {
    t.status = 'aberto';
    await notify('ticket', { title: `Nova mensagem em ${t.code}`, text, fields: [['Cliente', t.userName], ['Pedido', t.orderCode || '—']] });
  } else if (t.status !== 'fechado') t.status = 'respondido';
  await save(t);
  return t;
}
async function clearLine(t) {
  if (!t.ref) return;
  const o = await S.getOrder(t.ref.orderId).catch(() => null), l = o && o.lines[t.ref.line];
  if (l && l.replaceTicket === t.id) { l.replaceTicket = ''; await S.saveOrder(o); }
}
async function setStatus(id, status, by) {
  const t = await getTicket(id);
  if (!['aberto', 'fechado'].includes(status)) fail(400, 'Status inválido.');
  t.status = status;
  if (status === 'fechado') await clearLine(t);
  else if (t.ref && !t.resolution) { const o = await S.getOrder(t.ref.orderId).catch(() => null); if (o) { o.lines[t.ref.line].replaceTicket = t.id; await S.saveOrder(o); } }
  t.messages.push({ by: 'admin', name: by ? by.name : 'Equipe', text: status === 'fechado' ? 'Ticket encerrado.' : 'Ticket reaberto.', at: now(), system: true });
  await save(t);
  return t;
}
// Reposição automática: tira itens novos do estoque e mostra no pedido do cliente.
async function approveReplace(id, admin) {
  const t = await getTicket(id);
  if (t.type !== 'reposicao' || !t.ref) fail(400, 'Este ticket não é um pedido de reposição.');
  if (t.resolution) fail(409, 'Este pedido de reposição já foi resolvido.');
  const o = await S.getOrder(t.ref.orderId), l = o.lines[t.ref.line];
  if (!l || !l.delivered || l.delivered.type !== 'items') fail(409, 'A reposição automática só vale para itens em estoque. Responda o cliente e registre a entrega manualmente.');
  const p = await S.getJ(S.K.prod(l.pid)) || fail(409, 'O produto foi removido da loja.');
  const n = Math.max(1, t.ref.items.length || 1);
  const got = await S.reserve(p, n);   // 409 se não houver estoque
  (l.replacements = l.replacements || []).push({ at: now(), ticket: t.code, old: t.ref.items, items: got });
  l.replaceTicket = '';
  S.hist(o, admin, `Reposição aprovada (${n} item(ns)) pelo ticket ${t.code}`);
  await S.saveOrder(o);
  t.resolution = 'aprovada'; t.status = 'respondido';
  t.messages.push({ by: 'admin', name: admin.name, text: `Reposição aprovada: ${n} novo(s) item(ns) já aparece(m) no seu pedido ${o.code}.`, at: now(), system: true });
  await save(t);
  return t;
}
async function deny(id, admin, text) {
  const t = await getTicket(id);
  if (t.resolution) fail(409, 'Este pedido já foi resolvido.');
  t.resolution = 'negada'; t.status = 'fechado';
  t.messages.push({ by: 'admin', name: admin.name, text: str(text, 2000) || 'Pedido de reposição não aprovado.', at: now() });
  await clearLine(t);
  await save(t);
  return t;
}
const mget = async (ids) => (await S.mgetJ(ids.map(K.tk))).filter(Boolean);
async function listAdmin({ status, q } = {}) {
  let l = await mget(await r.cmd(['LRANGE', K.all, 0, 299]));
  if (status) l = l.filter((t) => t.status === status);
  if (q) { const x = q.toLowerCase(); l = l.filter((t) => `${t.code} ${t.userName} ${t.subject} ${t.orderCode}`.toLowerCase().includes(x)); }
  return l.sort((a, b) => b.updatedAt - a.updatedAt).map(summary);
}
const listUser = async (uid) => (await mget(await r.cmd(['LRANGE', K.user(uid), 0, 99]))).sort((a, b) => b.updatedAt - a.updatedAt).map(summary);
async function openCount() { return (await mget(await r.cmd(['LRANGE', K.all, 0, 299]))).filter((t) => t.status === 'aberto').length; }

module.exports = { create, reply, setStatus, approveReplace, deny, getTicket, listAdmin, listUser, openCount, summary };
