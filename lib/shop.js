'use strict';
// Regras de negócio da loja: configurações, categorias, produtos, estoque, pedidos, cupons e estatísticas.
// Tudo fica no Redis com o prefixo "cd:" (não mistura com o Wine). Pagamento: PIX automático pela MisticPay.
const crypto = require('crypto');
const r = require('./redis');
const { fail, str, int, bool, url, now, brl, isCpf, digits, HttpError } = require('./util');
const MP = require('./misticpay');

const K = {
  user: (i) => `cd:u:${i}`, email: (e) => `cd:ue:${e}`, users: 'cd:us',
  cats: 'cd:cats', prod: (i) => `cd:p:${i}`, prods: 'cd:ps', stock: (i) => `cd:st:${i}`, qty: (i) => `cd:q:${i}`,
  ord: (i) => `cd:o:${i}`, ordList: 'cd:ol', userOrd: (i) => `cd:uo:${i}`, pend: 'cd:pend',
  coupon: (c) => `cd:cp:${c}`, coupons: 'cd:cps', couponUse: (c) => `cd:cpu:${c}`,
  cfg: 'cd:cfg', port: 'cd:port', log: 'cd:log', msgs: 'cd:msgs', sweep: 'cd:sweep',
  pay: (i) => `cd:pay:${i}`, payLock: (i) => `cd:plock:${i}`, payChk: (i) => `cd:pchk:${i}`,
};
const SECTIONS = ['discord', 'roblox', 'outros'];
const newId = () => crypto.randomBytes(7).toString('hex');
const parse = (s) => { try { return JSON.parse(s); } catch (_) { return null; } };
const getJ = async (k) => { const v = await r.cmd(['GET', k]); return v ? parse(v) : null; };
const setJ = (k, o) => r.cmd(['SET', k, JSON.stringify(o)]);
const mgetJ = async (keys) => {
  const out = [];
  for (let i = 0; i < keys.length; i += 300) {
    const v = await r.cmd(['MGET', ...keys.slice(i, i + 300)]);
    out.push(...v.map((x) => (x ? parse(x) : null)));
  }
  return out;
};

/* ---------- Configurações ---------- */
const DEFAULT_CFG = {
  storeName: 'Caarldev',
  sections: {
    discord: { name: 'Discord', tagline: 'Contas, impulsos, farm de orbs e mais para o seu servidor.' },
    roblox: { name: 'Roblox', tagline: 'Arquivos Rbxl e modelos para o Roblox Studio lite.' },
    outros: { name: 'Outros', tagline: 'Produtos e serviços digitais avulsos.' },
  },
  announcement: { active: false, text: '', tone: 'info' },
  pix: { instructions: 'Pague o valor exato com o QR Code ou o PIX Copia e Cola. A confirmação é automática: assim que o pagamento cair, o pedido é liberado nesta página.' },
  contacts: { discord: '', whatsapp: '', email: 'caarldev@gmail.com' },
  reserveMinutes: 60, registrationOpen: true, maintenance: false, lowStock: 3,
};
const mergeCfg = (base, over) => {
  const out = { ...base };
  for (const k of Object.keys(base)) {
    if (over && over[k] !== undefined) out[k] = (base[k] && typeof base[k] === 'object') ? mergeCfg(base[k], over[k] || {}) : over[k];
  }
  return out;
};
const getCfg = async () => mergeCfg(DEFAULT_CFG, (await getJ(K.cfg)) || {});
async function saveCfg(i) {
  const c = await getCfg(), s = i.sections || {};
  c.storeName = str(i.storeName, 40) || c.storeName;
  for (const id of SECTIONS) c.sections[id] = { name: str(s[id] && s[id].name, 30) || DEFAULT_CFG.sections[id].name, tagline: str(s[id] && s[id].tagline, 160) };
  const a = i.announcement || {};
  c.announcement = { active: bool(a.active), text: str(a.text, 240), tone: ['info', 'warn', 'ok'].includes(a.tone) ? a.tone : 'info' };
  const p = i.pix || {};
  c.pix = { instructions: str(p.instructions, 500) || DEFAULT_CFG.pix.instructions };
  const t = i.contacts || {};
  c.contacts = { discord: url(t.discord), whatsapp: str(t.whatsapp, 30), email: str(t.email, 120) };
  c.reserveMinutes = int(i.reserveMinutes, 60, 5, 1440);
  c.registrationOpen = bool(i.registrationOpen);
  c.maintenance = bool(i.maintenance);
  c.lowStock = int(i.lowStock, 3, 0, 1000);
  await setJ(K.cfg, c);
  return c;
}
const publicCfg = (c) => ({
  storeName: c.storeName, sections: c.sections, announcement: c.announcement.active && c.announcement.text ? c.announcement : null,
  contacts: c.contacts, registrationOpen: c.registrationOpen, maintenance: c.maintenance,
});

/* ---------- Registro de ações do admin ---------- */
async function audit(by, action, detail) {
  await r.cmd(['LPUSH', K.log, JSON.stringify({ at: now(), by: by ? (by.email || by) : 'sistema', action, detail: str(detail, 300) })]);
  await r.cmd(['LTRIM', K.log, 0, 499]);
}

/* ---------- Categorias ---------- */
const SEED_CATS = [
  { section: 'roblox', name: 'Arquivos Rbxl', desc: 'Jogos e mapas completos em .rbxl.' },
  { section: 'roblox', name: 'Modelos Studio lite', desc: 'Modelos e sistemas prontos para o Roblox Studio lite.' },
  { section: 'discord', name: 'Contas', desc: 'Contas de Discord prontas para usar.' },
  { section: 'discord', name: 'Impulsos (Boosts)', desc: 'Impulsos para o seu servidor.' },
  { section: 'discord', name: 'Farm de orbs', desc: 'Farm de orbs para a sua conta.' },
  { section: 'outros', name: 'Diversos', desc: 'Qualquer outro produto digital.' },
];
async function getCats() {
  let c = await getJ(K.cats);
  if (!c) {
    c = SEED_CATS.map((x, i) => ({ id: newId(), order: i, active: true, ...x }));
    await r.cmd(['SET', K.cats, JSON.stringify(c), 'NX']);
    c = (await getJ(K.cats)) || c;
  }
  return c.sort((a, b) => a.order - b.order);
}
async function saveCategory(i) {
  const cats = await getCats();
  const section = SECTIONS.includes(i.section) ? i.section : fail(400, 'Escolha a parte do site (Discord, Roblox ou Outros).');
  const name = str(i.name, 50) || fail(400, 'Informe o nome da categoria.');
  let c = i.id ? cats.find((x) => x.id === i.id) : null;
  if (i.id && !c) fail(404, 'Categoria não encontrada.');
  if (!c) { c = { id: newId(), order: cats.length ? Math.max(...cats.map((x) => x.order)) + 1 : 0 }; cats.push(c); }
  Object.assign(c, { section, name, desc: str(i.desc, 160), active: i.active === undefined ? true : bool(i.active) });
  if (i.order !== undefined && i.order !== '') c.order = int(i.order, c.order, 0, 9999);
  await setJ(K.cats, cats);
  return c;
}
async function deleteCategory(id, moveTo) {
  const cats = await getCats();
  if (!cats.find((x) => x.id === id)) fail(404, 'Categoria não encontrada.');
  const prods = (await allProducts()).filter((p) => p.categoryId === id);
  if (prods.length) {
    if (!moveTo || moveTo === id || !cats.find((x) => x.id === moveTo)) fail(409, `Essa categoria tem ${prods.length} produto(s). Escolha para onde movê-los antes de apagar.`);
    for (const p of prods) { p.categoryId = moveTo; await setJ(K.prod(p.id), p); }
  }
  await setJ(K.cats, cats.filter((x) => x.id !== id));
}

/* ---------- Produtos e estoque ---------- */
async function allProducts() {
  const ids = await r.cmd(['SMEMBERS', K.prods]);
  return (await mgetJ(ids.map(K.prod))).filter(Boolean);
}
// Estoque de cada produto: "items" = tamanho da lista; outros = contador (ou ilimitado).
async function stockMap(ps) {
  const res = await r.pipe(ps.map((p) => (p.delivery === 'items' ? ['LLEN', K.stock(p.id)] : ['GET', K.qty(p.id)])));
  const m = {};
  ps.forEach((p, i) => {
    if (p.delivery === 'items') m[p.id] = { unlimited: false, count: Number(res[i]) || 0 };
    else if (p.unlimited || res[i] == null) m[p.id] = { unlimited: true, count: null };
    else m[p.id] = { unlimited: false, count: Math.max(0, Number(res[i]) || 0) };
  });
  return m;
}
const view = (p, cat, stk, admin) => {
  const o = {
    id: p.id, name: p.name, short: p.short, description: p.description, price: p.price, compareAt: p.compareAt || null,
    image: p.image, categoryId: p.categoryId, categoryName: cat ? cat.name : '', section: cat ? cat.section : 'outros',
    delivery: p.delivery, stock: stk, featured: !!p.featured, tags: p.tags || [], sold: p.sold || 0, maxPerOrder: p.maxPerOrder || 10,
  };
  if (admin) Object.assign(o, { active: !!p.active, link: p.link || '', unlimited: !!p.unlimited, createdAt: p.createdAt, updatedAt: p.updatedAt });
  return o;
};
async function listProducts({ admin = false, section, cat, q, id } = {}) {
  const [cats, ps] = await Promise.all([getCats(), allProducts()]);
  const catById = Object.fromEntries(cats.map((c) => [c.id, c]));
  let list = ps.filter((p) => admin || (p.active && catById[p.categoryId] && catById[p.categoryId].active));
  if (id) list = list.filter((p) => p.id === id);
  if (section) list = list.filter((p) => catById[p.categoryId] && catById[p.categoryId].section === section);
  if (cat) list = list.filter((p) => p.categoryId === cat);
  if (q) { const t = q.toLowerCase(); list = list.filter((p) => `${p.name} ${p.short} ${(p.tags || []).join(' ')}`.toLowerCase().includes(t)); }
  const stk = await stockMap(list);
  return list.map((p) => view(p, catById[p.categoryId], stk[p.id], admin)).sort((a, b) => (b.featured - a.featured) || a.name.localeCompare(b.name));
}
async function saveProduct(i) {
  const cats = await getCats();
  if (!cats.find((c) => c.id === i.categoryId)) fail(400, 'Escolha uma categoria.');
  const old = i.id ? await getJ(K.prod(i.id)) : null;
  if (i.id && !old) fail(404, 'Produto não encontrado.');
  const delivery = ['items', 'link', 'manual'].includes(i.delivery) ? i.delivery : 'manual';
  const price = int(i.price, 0, 0, 100000000);
  const compare = int(i.compareAt, 0, 0, 100000000);
  const p = {
    ...(old || { id: newId(), sold: 0, createdAt: now() }),
    name: str(i.name, 90), short: str(i.short, 160), description: str(i.description, 4000), image: url(i.image),
    categoryId: i.categoryId, price, compareAt: compare > price ? compare : 0, delivery,
    link: delivery === 'link' ? url(i.link) : '', unlimited: delivery === 'items' ? false : bool(i.unlimited),
    maxPerOrder: int(i.maxPerOrder, 10, 1, 100), featured: bool(i.featured), active: i.active === undefined ? true : bool(i.active),
    tags: String(i.tags || '').split(',').map((t) => str(t, 24)).filter(Boolean).slice(0, 8), updatedAt: now(),
  };
  if (!p.name) fail(400, 'Informe o nome do produto.');
  if (delivery === 'link' && !p.link) fail(400, 'Informe um link de download válido (começando com https://).');
  await setJ(K.prod(p.id), p);
  await r.cmd(['SADD', K.prods, p.id]);
  if (delivery !== 'items' && !p.unlimited) {
    if (i.qty !== undefined && i.qty !== '' && i.qty !== null) await r.cmd(['SET', K.qty(p.id), int(i.qty, 0, 0, 1e9)]);
    else if ((await r.cmd(['GET', K.qty(p.id)])) == null) await r.cmd(['SET', K.qty(p.id), 0]);
  }
  return p;
}
async function deleteProduct(id) {
  await r.cmd(['SREM', K.prods, id]);
  await r.cmd(['DEL', K.prod(id), K.stock(id), K.qty(id)]);
}
async function stockInfo(id) {
  const p = await getJ(K.prod(id)) || fail(404, 'Produto não encontrado.');
  if (p.delivery === 'items') {
    const [len, items] = await Promise.all([r.cmd(['LLEN', K.stock(id)]), r.cmd(['LRANGE', K.stock(id), 0, 299])]);
    return { delivery: 'items', count: Number(len), items };
  }
  const m = (await stockMap([p]))[id];
  return { delivery: p.delivery, unlimited: m.unlimited, count: m.count };
}
async function stockAction(id, i) {
  const p = await getJ(K.prod(id)) || fail(404, 'Produto não encontrado.');
  const items = p.delivery === 'items';
  switch (i.action) {
    case 'add': {
      if (!items) fail(400, 'Este produto não usa itens em estoque.');
      const lines = String(i.lines || '').split(/\r?\n/).map((l) => str(l, 2000)).filter(Boolean).slice(0, 2000);
      if (!lines.length) fail(400, 'Cole pelo menos uma linha.');
      for (let n = 0; n < lines.length; n += 200) await r.cmd(['RPUSH', K.stock(id), ...lines.slice(n, n + 200)]);
      return { added: lines.length };
    }
    case 'remove':
      if (!items) fail(400, 'Este produto não usa itens em estoque.');
      return { removed: Number(await r.cmd(['LREM', K.stock(id), 1, String(i.value)])) };
    case 'clear':
      await r.cmd(['DEL', items ? K.stock(id) : K.qty(id)]);
      if (!items && !p.unlimited) await r.cmd(['SET', K.qty(id), 0]);
      return { cleared: true };
    case 'set':
    case 'adjust': {
      if (items || p.unlimited) fail(400, 'Este produto não usa contador de estoque.');
      const n = i.action === 'set' ? (await r.cmd(['SET', K.qty(id), int(i.qty, 0, 0, 1e9)]), int(i.qty, 0, 0, 1e9)) : Math.max(0, Number(await r.cmd(['INCRBY', K.qty(id), int(i.qty, 0, -1e9, 1e9)])));
      return { count: Number(n) };
    }
    default: fail(400, 'Ação de estoque desconhecida.');
  }
}

/* ---------- Cupons ---------- */
async function saveCoupon(i) {
  const code = str(i.code, 30).toUpperCase().replace(/[^A-Z0-9_-]/g, '');
  if (code.length < 3) fail(400, 'O código precisa ter pelo menos 3 letras ou números.');
  const old = await getJ(K.coupon(code));
  const type = i.type === 'fixed' ? 'fixed' : 'percent';
  const value = type === 'percent' ? int(i.value, 10, 1, 100) : int(i.value, 0, 1, 100000000);
  const c = {
    ...(old || { createdAt: now() }), code, type, value, active: i.active === undefined ? true : bool(i.active),
    maxUses: int(i.maxUses, 0, 0, 1e9), minTotal: int(i.minTotal, 0, 0, 1e9), section: SECTIONS.includes(i.section) ? i.section : '',
    expiresAt: i.expiresAt ? int(i.expiresAt, 0, 0, 4e12) : 0,
  };
  await setJ(K.coupon(code), c);
  await r.cmd(['SADD', K.coupons, code]);
  return c;
}
async function listCoupons() {
  const codes = await r.cmd(['SMEMBERS', K.coupons]);
  if (!codes.length) return [];
  const [cs, used] = await Promise.all([mgetJ(codes.map(K.coupon)), r.pipe(codes.map((c) => ['GET', K.couponUse(c)]))]);
  return cs.map((c, i) => c && { ...c, used: Number(used[i]) || 0 }).filter(Boolean).sort((a, b) => b.createdAt - a.createdAt);
}
async function checkCoupon(code, subtotal, section) {
  code = str(code, 30).toUpperCase();
  if (!code) return null;
  const c = await getJ(K.coupon(code));
  if (!c || !c.active) fail(400, 'Cupom inválido.');
  if (c.expiresAt && c.expiresAt < now()) fail(400, 'Cupom expirado.');
  if (c.minTotal && subtotal < c.minTotal) fail(400, `Este cupom vale para pedidos a partir de ${brl(c.minTotal)}.`);
  if (c.section && c.section !== section) fail(400, 'Este cupom não vale para esse produto.');
  const used = Number(await r.cmd(['GET', K.couponUse(code)])) || 0;
  if (c.maxUses && used >= c.maxUses) fail(400, 'Este cupom já foi totalmente usado.');
  const discount = c.type === 'percent' ? Math.round((subtotal * c.value) / 100) : Math.min(subtotal, c.value);
  return { code, discount };
}

/* ---------- Pedidos ---------- */
const OPEN = ['pendente', 'aguardando'];
const hist = (o, by, what) => { (o.history = o.history || []).push({ at: now(), by: by ? by.email || by : 'cliente', what }); };
const saveOrder = (o) => setJ(K.ord(o.id), o);
const orderCode = () => 'CD-' + crypto.randomBytes(4).toString('hex').toUpperCase();

// Separa o estoque do pedido na hora da compra, para ninguém comprar o mesmo item duas vezes.
async function reserve(p, qty) {
  if (p.delivery === 'items') {
    const got = (await r.pipe(Array.from({ length: qty }, () => ['LPOP', K.stock(p.id)]))).filter((v) => v != null);
    if (got.length < qty) {
      if (got.length) await r.cmd(['LPUSH', K.stock(p.id), ...got.slice().reverse()]);
      fail(409, 'Não há estoque suficiente para essa quantidade.');
    }
    return got;
  }
  if (!p.unlimited) {
    const left = Number(await r.cmd(['DECRBY', K.qty(p.id), qty]));
    if (left < 0) { await r.cmd(['INCRBY', K.qty(p.id), qty]); fail(409, 'Não há estoque suficiente para essa quantidade.'); }
  }
  return [];
}
async function release(p, qty, items) {
  if (!p) return;
  if (p.delivery === 'items') { if (items && items.length) await r.cmd(['LPUSH', K.stock(p.id), ...items.slice().reverse()]); }
  else if (!p.unlimited) await r.cmd(['INCRBY', K.qty(p.id), qty]);
}

async function createOrder(user, i, ctx = {}) {
  const cfg = await getCfg();
  const [p, cats] = await Promise.all([getJ(K.prod(str(i.productId, 40))), getCats()]);
  const cat = p && cats.find((c) => c.id === p.categoryId);
  if (!p || !p.active || !cat || !cat.active) fail(404, 'Produto indisponível.');
  const qty = int(i.qty, 1, 1, p.maxPerOrder || 10);
  const subtotal = p.price * qty;
  const cp = await checkCoupon(i.coupon, subtotal, cat.section);
  const total = Math.max(0, subtotal - (cp ? cp.discount : 0));
  // O PIX exige o CPF de quem paga. Confere antes de reservar estoque. Não é guardado.
  const cpf = digits(i.cpf);
  if (total > 0) {
    if (!isCpf(cpf)) fail(400, 'Informe um CPF válido para gerar o PIX.');
    if (!MP.configured()) { const e = new Error('MISTICPAY_CLIENT_ID e MISTICPAY_CLIENT_SECRET não configurados'); e.setup = true; throw e; }
  }
  const reserved = await reserve(p, qty);
  try {
    if (cp) {
      const c = await getJ(K.coupon(cp.code));
      const used = Number(await r.cmd(['INCR', K.couponUse(cp.code)]));
      if (c.maxUses && used > c.maxUses) { await r.cmd(['DECR', K.couponUse(cp.code)]); fail(400, 'Este cupom já foi totalmente usado.'); }
    }
  } catch (e) { await release(p, qty, reserved); throw e; }
  const o = {
    id: newId(), code: orderCode(), userId: user.id, userName: user.name, userEmail: user.email, status: 'pendente',
    lines: [{ pid: p.id, name: p.name, unit: p.price, qty, catId: cat.id, catName: cat.name, section: cat.section, delivery: p.delivery, link: p.link || '' }],
    subtotal, discount: cp ? cp.discount : 0, total, coupon: cp ? cp.code : null,
    contact: str(i.contact, 80), note: str(i.note, 300), createdAt: now(), expiresAt: now() + cfg.reserveMinutes * 60000,
    reserved, delivery: null, history: [],
  };
  hist(o, user, 'Pedido criado');
  await saveOrder(o);
  await r.cmd(['LPUSH', K.ordList, o.id]);
  await r.cmd(['LPUSH', K.userOrd(user.id), o.id]);
  await r.cmd(['SADD', K.pend, o.id]);
  if (total === 0) return markPaid(o, 'sistema');
  try { await startPayment(o, cpf, ctx.webhookUrl); }
  catch (e) { try { await closeOpen(o, 'sistema', 'cancelado', 'Não foi possível gerar o PIX'); } catch (_) { /* já tratado */ } throw e; }
  return o;
}

/* ---------- Pagamento automático (MisticPay) ---------- */
// Gera a cobrança PIX do pedido e guarda o código para a página do pedido mostrar.
async function startPayment(o, cpf, webhookUrl) {
  const ch = await MP.createCharge({
    amountCents: o.total, orderId: o.id, payerName: str(o.userName, 60), payerDocument: cpf,
    description: `Pedido ${o.code} - ${o.lines[0].name}`.slice(0, 120), webhookUrl,
  });
  o.pay = { provider: 'misticpay', txId: ch.txId, copyPaste: ch.copyPaste, qr: ch.qr, createdAt: now() };
  hist(o, 'sistema', 'PIX gerado (MisticPay)');
  await saveOrder(o);
  await r.cmd(['SET', K.pay(ch.txId), o.id, 'EX', 60 * 86400]);
}

// Acha o pedido pelo id que a MisticPay manda no webhook (o nosso ou o dela).
async function findOrderByRef(ref) {
  ref = str(ref, 80);
  if (!ref) return null;
  const direct = await getJ(K.ord(ref));
  if (direct) return direct;
  const id = await r.cmd(['GET', K.pay(ref)]);
  return id ? getJ(K.ord(id)) : null;
}

// Confirma o pagamento SEM confiar no corpo do webhook: pergunta à MisticPay (com a nossa chave)
// se a cobrança está COMPLETA e se o valor cobre o pedido. Só então libera. Seguro para chamar
// várias vezes (webhook, atualização da página, varredura): um trava por pedido evita liberar em dobro.
async function confirmPayment(o) {
  if (!o || !o.pay || !['pendente', 'aguardando', 'expirado', 'cancelado'].includes(o.status) || o.payIssue) return o;
  if ((await r.cmd(['SET', K.payLock(o.id), '1', 'NX', 'EX', 30])) === null) return o;
  try {
    const fresh = await getOrder(o.id);
    if (!fresh.pay || !['pendente', 'aguardando', 'expirado', 'cancelado'].includes(fresh.status) || fresh.payIssue) return fresh;
    const tx = await MP.checkCharge(fresh.id, fresh.pay.txId);
    if (tx.state !== 'COMPLETO' || (tx.type && tx.type !== 'DEPOSITO')) return fresh;
    const issue = async (msg) => { fresh.payIssue = msg; hist(fresh, 'MisticPay', msg); await saveOrder(fresh); await audit('sistema', 'pagamento:atencao', `${fresh.code}: ${msg}`); return fresh; };
    if (!(tx.valueCents >= fresh.total - 1)) return issue(`Valor pago (${brl(tx.valueCents)}) menor que o do pedido (${brl(fresh.total)}). Confira no painel da MisticPay.`);
    if (fresh.status === 'cancelado') return issue('Pagamento recebido depois de o pedido ser cancelado. Entregue manualmente ou reembolse pela MisticPay.');
    try {
      const paid = await markPaid(fresh, 'MisticPay');
      await audit('sistema', 'pagamento:confirmado', paid.code);
      return paid;
    } catch (e) {
      if (e instanceof HttpError) return issue(`Pagamento recebido, mas o pedido não pôde ser liberado: ${e.message} Entregue manualmente ou reembolse pela MisticPay.`);
      throw e;
    }
  } finally { await r.cmd(['DEL', K.payLock(o.id)]).catch(() => {}); }
}
// Usada ao abrir o pedido: se o webhook atrasar ou falhar, a própria página confirma (no máximo 1 consulta a cada 6 s).
async function refreshPayment(o) {
  if (!o.pay || !OPEN.includes(o.status)) return o;
  if ((await r.cmd(['SET', K.payChk(o.id), '1', 'NX', 'EX', 6])) === null) return o;
  try { return await confirmPayment(o); } catch (e) { console.error('[pagamento]', String((e && e.message) || e)); return o; }
}
// Reembolso avisado pela MisticPay: só registra para o admin decidir (a entrega já pode ter acontecido).
async function noteRefund(o, info) {
  const st = String(info.status || '').toUpperCase(), rf = info.refund || {};
  const refused = String(rf.status || '').toUpperCase() === 'RECUSADO';
  const what = refused ? 'MisticPay: o reembolso foi recusado pelo banco (valor continua pago)'
    : `MisticPay: ${st === 'DEVOLVIDO_PARCIAL' ? 'reembolso parcial' : 'reembolso total'} do PIX${rf.refundedValue != null ? ` (${rf.refundedValue})` : ''}`;
  if ((o.history || []).some((h) => h.what === what)) return o;
  hist(o, 'MisticPay', what);
  if (!refused) o.payIssue = `${what}. Confira a entrega e, se for o caso, use "Reembolsar".`;
  await saveOrder(o);
  await audit('sistema', 'pagamento:reembolso', `${o.code}: ${what}`);
  return o;
}

async function markPaid(o, by) {
  if (!['pendente', 'aguardando', 'expirado'].includes(o.status)) fail(409, 'Esse pedido não pode ser marcado como pago.');
  const line = o.lines[0], p = await getJ(K.prod(line.pid));
  if (o.status === 'expirado') {
    if (!p) fail(409, 'O produto foi removido; não dá para reabrir esse pedido.');
    o.reserved = await reserve(p, line.qty);
    if (o.coupon) await r.cmd(['INCR', K.couponUse(o.coupon)]);
    hist(o, by, 'Pedido reaberto');
  }
  o.paidAt = now();
  o.status = 'pago';
  delete o.payIssue;
  if (line.delivery === 'items') { o.delivery = { type: 'items', items: o.reserved || [] }; o.reserved = []; }
  else if (line.delivery === 'link') o.delivery = { type: 'link', url: (p && p.link) || line.link };
  if (o.delivery) { o.status = 'entregue'; o.deliveredAt = now(); }
  hist(o, by, o.delivery ? 'Pagamento confirmado e produto entregue' : 'Pagamento confirmado (entrega manual pendente)');
  await saveOrder(o);
  await r.cmd(['SREM', K.pend, o.id]);
  if (p) { p.sold = (p.sold || 0) + line.qty; await setJ(K.prod(p.id), p); }
  return o;
}
async function closeOpen(o, by, status, why) {
  if (!OPEN.includes(o.status)) fail(409, 'Só dá para cancelar pedidos que ainda não foram pagos.');
  const line = o.lines[0];
  await release(await getJ(K.prod(line.pid)), line.qty, o.reserved);
  if (o.coupon) await r.cmd(['DECR', K.couponUse(o.coupon)]);
  o.reserved = []; o.status = status; o.closedAt = now();
  hist(o, by, why);
  await saveOrder(o);
  await r.cmd(['SREM', K.pend, o.id]);
  return o;
}
async function refund(o, by, restock) {
  if (!['pago', 'entregue'].includes(o.status)) fail(409, 'Só dá para reembolsar pedidos pagos.');
  const line = o.lines[0], p = await getJ(K.prod(line.pid));
  if (restock && p) await release(p, line.qty, o.delivery && o.delivery.items);
  if (p) { p.sold = Math.max(0, (p.sold || 0) - line.qty); await setJ(K.prod(p.id), p); }
  o.status = 'reembolsado'; o.closedAt = now();
  delete o.payIssue;
  hist(o, by, restock ? 'Reembolsado (voltou ao estoque)' : 'Reembolsado');
  await saveOrder(o);
  return o;
}
// Libera o estoque de pedidos não pagos que passaram do prazo. Roda no máximo 1x por minuto.
async function sweepExpired(force) {
  if (!force && (await r.cmd(['SET', K.sweep, '1', 'NX', 'EX', 60])) === null) return 0;
  const ids = await r.cmd(['SMEMBERS', K.pend]);
  let n = 0;
  for (const o of (await mgetJ(ids.map(K.ord)))) {
    if (!o) continue;
    if (o.status === 'pendente' && o.expiresAt < now()) {
      try {
        if (o.pay) { const c = await confirmPayment(o).catch(() => o); if (c.status !== 'pendente') continue; } // pagou no último minuto
        await closeOpen(o, 'sistema', 'expirado', 'Pedido expirado sem pagamento'); n++;
      } catch (_) { /* outro processo já cuidou */ }
    }
  }
  return n;
}
const userOrder = (o, cfg) => {
  const { reserved, history, pay, payIssue, ...rest } = o;
  const out = { ...rest, lines: o.lines.map(({ link, ...l }) => l) };
  delete out.adminNote;
  if (o.status !== 'entregue') out.delivery = null;
  out.payment = OPEN.includes(o.status) && pay ? { instructions: cfg.pix.instructions, copyPaste: pay.copyPaste, qr: pay.qr || '' } : null;
  return out;
};
const adminOrder = (o) => { const { reserved, pay, ...rest } = o; return { ...rest, payRef: pay ? pay.txId : '' }; };
const getOrder = async (id) => (await getJ(K.ord(str(id, 40)))) || fail(404, 'Pedido não encontrado.');
async function listOrders({ status, q, limit = 300 } = {}) {
  const ids = await r.cmd(['LRANGE', K.ordList, 0, 1999]);
  let list = (await mgetJ(ids.map(K.ord))).filter(Boolean);
  if (status) list = list.filter((o) => o.status === status);
  if (q) { const t = q.toLowerCase(); list = list.filter((o) => `${o.code} ${o.userName} ${o.userEmail} ${o.contact} ${o.lines[0].name}`.toLowerCase().includes(t)); }
  return list.slice(0, limit).map(adminOrder);
}

/* ---------- Usuários ---------- */
const publicUser = (u) => u && { id: u.id, name: u.name, email: u.email, role: u.role, createdAt: u.createdAt };
async function listUsers(q) {
  const ids = await r.cmd(['SMEMBERS', K.users]);
  let us = (await mgetJ(ids.map(K.user))).filter(Boolean);
  if (q) { const t = q.toLowerCase(); us = us.filter((u) => `${u.name} ${u.email}`.toLowerCase().includes(t)); }
  const counts = await r.pipe(us.map((u) => ['LLEN', K.userOrd(u.id)]));
  return us.map((u, i) => ({ id: u.id, name: u.name, email: u.email, role: u.role, banned: !!u.banned, banReason: u.banReason || '', createdAt: u.createdAt, lastLogin: u.lastLogin || 0, orders: Number(counts[i]) || 0 }))
    .sort((a, b) => b.createdAt - a.createdAt);
}

/* ---------- Portfólio ---------- */
const DEFAULT_PORT = [
  { id: 'p1', title: 'Cutscene cinematográfica', tag: 'Cutscene', desc: 'Câmera, luz e atuação em uma sequência completa.', image: '', video: '', wide: true },
  { id: 'p2', title: 'Animação de combate', tag: 'Animação', desc: 'Peso, impacto e fluidez.', image: '', video: '', wide: false },
  { id: 'p3', title: 'Personagem realista', tag: 'Modelo 3D', desc: 'Modelagem e texturas PBR.', image: '', video: '', wide: false },
  { id: 'p4', title: 'Fogo e partículas', tag: 'Efeitos 3D', desc: 'Simulações com acabamento de cinema.', image: '', video: '', wide: true },
];
const getPortfolio = async () => (await getJ(K.port)) || DEFAULT_PORT;
async function savePortfolio(items) {
  if (!Array.isArray(items)) fail(400, 'Lista inválida.');
  const clean = items.slice(0, 40).map((x) => ({
    id: str(x.id, 20) || newId(), title: str(x.title, 80), tag: str(x.tag, 30), desc: str(x.desc, 200),
    image: url(x.image), video: url(x.video), wide: bool(x.wide),
  })).filter((x) => x.title);
  await setJ(K.port, clean);
  return clean;
}

/* ---------- Painel: números ---------- */
const BRT = 3 * 3600e3; // Brasil sem horário de verão: UTC-3
const dayKey = (t) => new Date(t - BRT).toISOString().slice(0, 10);
async function stats() {
  const cfg = await getCfg();
  const ids = await r.cmd(['LRANGE', K.ordList, 0, 2999]);
  const orders = (await mgetJ(ids.map(K.ord))).filter(Boolean);
  const [ps, cats, users] = await Promise.all([allProducts(), getCats(), listUsers()]);
  const stk = await stockMap(ps);
  const isPaid = (o) => o.status === 'pago' || o.status === 'entregue';
  const t = now(), today = dayKey(t);
  const series = [];
  for (let d = 29; d >= 0; d--) series.push({ date: dayKey(t - d * 864e5), revenue: 0, orders: 0 });
  const idx = Object.fromEntries(series.map((s, i) => [s.date, i]));
  const periods = { today: { revenue: 0, orders: 0 }, d7: { revenue: 0, orders: 0 }, d30: { revenue: 0, orders: 0 } };
  const byStatus = {}, bySection = {}, top = {};
  let revenue = 0, paidCount = 0;
  for (const o of orders) {
    byStatus[o.status] = (byStatus[o.status] || 0) + 1;
    if (!isPaid(o)) continue;
    const when = o.paidAt || o.createdAt, age = t - when;
    revenue += o.total; paidCount++;
    const k = dayKey(when);
    if (k in idx) { series[idx[k]].revenue += o.total; series[idx[k]].orders++; }
    if (k === today) { periods.today.revenue += o.total; periods.today.orders++; }
    if (age < 7 * 864e5) { periods.d7.revenue += o.total; periods.d7.orders++; }
    if (age < 30 * 864e5) { periods.d30.revenue += o.total; periods.d30.orders++; }
    const l = o.lines[0];
    (bySection[l.section] = bySection[l.section] || { revenue: 0, orders: 0 });
    bySection[l.section].revenue += o.total; bySection[l.section].orders++;
    (top[l.pid] = top[l.pid] || { name: l.name, qty: 0, revenue: 0 });
    top[l.pid].qty += l.qty; top[l.pid].revenue += o.total;
  }
  const catById = Object.fromEntries(cats.map((c) => [c.id, c]));
  const lowStock = ps.filter((p) => p.active && !stk[p.id].unlimited && stk[p.id].count <= cfg.lowStock)
    .map((p) => ({ id: p.id, name: p.name, count: stk[p.id].count, section: catById[p.categoryId] ? catById[p.categoryId].section : 'outros' }));
  return {
    totals: {
      revenue, paidOrders: paidCount, orders: orders.length, avgTicket: paidCount ? Math.round(revenue / paidCount) : 0,
      users: users.length, banned: users.filter((u) => u.banned).length, newUsers30: users.filter((u) => t - u.createdAt < 30 * 864e5).length,
      products: ps.length, activeProducts: ps.filter((p) => p.active).length,
    },
    periods, byStatus, bySection, series,
    topProducts: Object.values(top).sort((a, b) => b.revenue - a.revenue).slice(0, 6),
    lowStock, needsAction: orders.filter((o) => o.status === 'aguardando' || o.status === 'pago' || o.payIssue).slice(0, 10).map(adminOrder),
    recent: orders.slice(0, 8).map(adminOrder),
  };
}

module.exports = {
  K, SECTIONS, OPEN, newId, getJ, setJ, mgetJ, getCfg, saveCfg, publicCfg, audit, getCats, saveCategory, deleteCategory,
  listProducts, saveProduct, deleteProduct, stockInfo, stockAction, saveCoupon, listCoupons, checkCoupon,
  createOrder, confirmPayment, refreshPayment, findOrderByRef, noteRefund, markPaid, closeOpen, refund, sweepExpired, userOrder, adminOrder, getOrder, listOrders, hist, saveOrder,
  publicUser, listUsers, getPortfolio, savePortfolio, stats, allProducts,
};
