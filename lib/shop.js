'use strict';
// Regras de negócio da loja: configurações, categorias, produtos, estoque, pedidos, cupons e estatísticas.
// Tudo fica no Redis com o prefixo "cd:" (não mistura com o Wine). Pagamento: PIX automático pela MisticPay.
const crypto = require('crypto');
const r = require('./redis');
const { fail, str, int, bool, url, now, brl, isCpf, digits, HttpError, dayStart, dayEnd } = require('./util');
const MP = require('./misticpay');
const { notify, hookUrl, isHook } = require('./notify');

const K = {
  user: (i) => `cd:u:${i}`, email: (e) => `cd:ue:${e}`, users: 'cd:us',
  cats: 'cd:cats', prod: (i) => `cd:p:${i}`, prods: 'cd:ps', stock: (i) => `cd:st:${i}`, qty: (i) => `cd:q:${i}`,
  ord: (i) => `cd:o:${i}`, ordList: 'cd:ol', userOrd: (i) => `cd:uo:${i}`, pend: 'cd:pend',
  coupon: (c) => `cd:cp:${c}`, coupons: 'cd:cps', couponUse: (c) => `cd:cpu:${c}`,
  cfg: 'cd:cfg', port: 'cd:port', log: 'cd:log', msgs: 'cd:msgs', sweep: 'cd:sweep',
  couponUser: (c, u) => `cd:cpuu:${c}:${u}`, couponPaidN: (c) => `cd:cpn:${c}`, couponRev: (c) => `cd:cpr:${c}`, lowPing: (i) => `cd:low:${i}`,
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
  notify: { webhook: '', neworder: false, paid: true, attention: true, lowstock: true, ticket: true, contact: true, review: true },  // avisos no Discord
  download: { days: 30, max: 10 },        // prazo (dias) e limite de downloads de arquivos; 0 = sem limite
  pages: { terms: '', refund: '', privacy: '', faq: [] },   // vazio = texto padrão (lib/pages.js)
};
const mergeCfg = (base, over) => {
  const out = { ...base };
  for (const k of Object.keys(base)) {
    if (over && over[k] !== undefined) out[k] = (base[k] && typeof base[k] === 'object' && !Array.isArray(base[k])) ? mergeCfg(base[k], over[k] || {}) : over[k];
  }
  return out;
};
const getCfg = async () => mergeCfg(DEFAULT_CFG, (await getJ(K.cfg)) || {});
async function saveCfg(i) {
  const c = await getCfg(), s = i.sections || {};
  if (i.storeName !== undefined) c.storeName = str(i.storeName, 40) || c.storeName;
  if (i.sections) for (const id of SECTIONS) c.sections[id] = { name: str(s[id] && s[id].name, 30) || DEFAULT_CFG.sections[id].name, tagline: str(s[id] && s[id].tagline, 160) };
  if (i.announcement) { const a = i.announcement; c.announcement = { active: bool(a.active), text: str(a.text, 240), tone: ['info', 'warn', 'ok'].includes(a.tone) ? a.tone : 'info' }; }
  if (i.pix) c.pix = { instructions: str(i.pix.instructions, 500) || DEFAULT_CFG.pix.instructions };
  if (i.contacts) { const t = i.contacts; c.contacts = { discord: url(t.discord), whatsapp: str(t.whatsapp, 30), email: str(t.email, 120) }; }
  if (i.reserveMinutes !== undefined) c.reserveMinutes = int(i.reserveMinutes, 60, 5, 1440);
  if (i.registrationOpen !== undefined) c.registrationOpen = bool(i.registrationOpen);
  if (i.maintenance !== undefined) c.maintenance = bool(i.maintenance);
  if (i.lowStock !== undefined) c.lowStock = int(i.lowStock, 3, 0, 1000);
  if (i.notify) { const n = i.notify; c.notify = { webhook: isHook(n.webhook) ? n.webhook : '', neworder: bool(n.neworder), paid: bool(n.paid), attention: bool(n.attention), lowstock: bool(n.lowstock), ticket: bool(n.ticket), contact: bool(n.contact), review: bool(n.review) }; }
  if (i.download) c.download = { days: int(i.download.days, 30, 0, 3650), max: int(i.download.max, 10, 0, 1000) };
  await setJ(K.cfg, c);
  return c;
}
// Textos das páginas Termos, Reembolso, Privacidade e FAQ (vazio = volta ao texto padrão).
async function savePages(i) {
  const c = await getCfg();
  const faq = (Array.isArray(i.faq) ? i.faq : []).slice(0, 30).map((x) => ({ q: str(x && x.q, 200), a: str(x && x.a, 2000) })).filter((x) => x.q && x.a);
  c.pages = { terms: str(i.terms, 20000), refund: str(i.refund, 20000), privacy: str(i.privacy, 20000), faq };
  await setJ(K.cfg, c);
  return c.pages;
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
    gallery: p.gallery || [], video: p.video || '', includes: p.includes || [], warrantyDays: p.warrantyDays || 0, rating: p.rating || 0, ratingCount: p.ratingCount || 0,
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
// Uma linha por item (galeria, "o que vem incluso"). Aceita texto com quebras de linha ou lista.
const lines = (v, max) => (Array.isArray(v) ? v : String(v || '').split(/\r?\n/)).map((x) => String(x).trim()).filter(Boolean).slice(0, max);
// Vídeo do produto: link direto (.mp4/.webm) ou YouTube (vira o endereço de incorporação).
function videoUrl(v) {
  v = str(v, 300);
  if (!v) return '';
  const m = /^https?:\/\/(?:www\.|m\.)?(?:youtube\.com\/(?:watch\?(?:[^#]*&)?v=|embed\/|shorts\/)|youtu\.be\/)([\w-]{11})/i.exec(v);
  return m ? `https://www.youtube-nocookie.com/embed/${m[1]}` : url(v);
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
    gallery: lines(i.gallery, 6).map(url).filter(Boolean), video: videoUrl(i.video), includes: lines(i.includes, 12).map((x) => str(x, 90)).filter(Boolean),
    warrantyDays: int(i.warrantyDays, 0, 0, 365),
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
async function duplicateProduct(id) {
  const old = await getJ(K.prod(str(id, 40))) || fail(404, 'Produto não encontrado.');
  const p = { ...old, id: newId(), name: `${old.name} (cópia)`.slice(0, 90), active: false, featured: false, sold: 0, rating: 0, ratingCount: 0, createdAt: now(), updatedAt: now() };
  await setJ(K.prod(p.id), p);
  await r.cmd(['SADD', K.prods, p.id]);
  if (p.delivery !== 'items' && !p.unlimited) await r.cmd(['SET', K.qty(p.id), 0]);   // o estoque não é copiado
  return p;
}
// Ações em massa: show | hide | feature | unfeature | move (categoryId) | price (percent: -90..500) | delete
async function bulkProducts(ids, action, extra = {}) {
  ids = [...new Set((Array.isArray(ids) ? ids : []).map((x) => str(x, 40)).filter(Boolean))].slice(0, 200);
  if (!ids.length) fail(400, 'Selecione pelo menos um produto.');
  const cats = await getCats();
  if (action === 'move' && !cats.find((c) => c.id === extra.categoryId)) fail(400, 'Escolha a categoria de destino.');
  if (!['show', 'hide', 'feature', 'unfeature', 'move', 'price', 'delete'].includes(action)) fail(400, 'Ação desconhecida.');
  const pct = int(extra.percent, 0, -90, 500);
  if (action === 'price' && !pct) fail(400, 'Informe a porcentagem do reajuste (ex.: 10 ou -15).');
  let n = 0;
  for (const p of (await mgetJ(ids.map(K.prod))).filter(Boolean)) {
    if (action === 'delete') { await deleteProduct(p.id); n++; continue; }
    if (action === 'show' || action === 'hide') p.active = action === 'show';
    else if (action === 'feature' || action === 'unfeature') p.featured = action === 'feature';
    else if (action === 'move') p.categoryId = extra.categoryId;
    else if (action === 'price') { p.price = Math.max(0, Math.round(p.price * (1 + pct / 100))); if (p.compareAt && p.compareAt <= p.price) p.compareAt = 0; }
    p.updatedAt = now(); await setJ(K.prod(p.id), p); n++;
  }
  return { changed: n };
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
    perUser: int(i.perUser, 0, 0, 1000), firstOrder: bool(i.firstOrder),               // limite por cliente; só primeira compra
    affiliateName: str(i.affiliateName, 60), commissionPct: int(i.commissionPct, 0, 0, 100), paidOut: (old && old.paidOut) || 0, // afiliado
  };
  await setJ(K.coupon(code), c);
  await r.cmd(['SADD', K.coupons, code]);
  return c;
}
async function listCoupons() {
  const codes = await r.cmd(['SMEMBERS', K.coupons]);
  if (!codes.length) return [];
  const [cs, res] = await Promise.all([mgetJ(codes.map(K.coupon)), r.pipe(codes.flatMap((c) => [['GET', K.couponUse(c)], ['GET', K.couponPaidN(c)], ['GET', K.couponRev(c)]]))]);
  return cs.map((c, i) => {
    if (!c) return null;
    const revenue = Number(res[i * 3 + 2]) || 0, commission = Math.round(revenue * (c.commissionPct || 0) / 100);
    return { ...c, used: Number(res[i * 3]) || 0, paidOrders: Number(res[i * 3 + 1]) || 0, revenue, commission, owed: Math.max(0, commission - (c.paidOut || 0)) };
  }).filter(Boolean).sort((a, b) => b.createdAt - a.createdAt);
}
async function couponPayout(code, amount) {
  const c = await getJ(K.coupon(str(code, 30).toUpperCase())) || fail(404, 'Cupom não encontrado.');
  c.paidOut = Math.max(0, (c.paidOut || 0) + int(amount, 0, -1e9, 1e9));
  await setJ(K.coupon(c.code), c);
  return c;
}
const BUSY = ['pendente', 'aguardando', 'pago', 'entregue'];
async function hasOrders(userId) {
  const ids = await r.cmd(['LRANGE', K.userOrd(userId), 0, 49]);
  return (await mgetJ(ids.map(K.ord))).some((o) => o && BUSY.includes(o.status));
}
// lines: [{ unit, qty, section }]. user: quem compra (para limite por cliente e "primeira compra").
async function checkCoupon(code, lines, user) {
  code = str(code, 30).toUpperCase();
  if (!code) return null;
  const c = await getJ(K.coupon(code));
  if (!c || !c.active) fail(400, 'Cupom inválido.');
  if (c.expiresAt && c.expiresAt < now()) fail(400, 'Cupom expirado.');
  const elig = lines.filter((l) => !c.section || l.section === c.section);
  if (!elig.length) fail(400, 'Este cupom não vale para esse produto.');
  const base = elig.reduce((s, l) => s + l.unit * l.qty, 0);
  if (c.minTotal && base < c.minTotal) fail(400, `Este cupom vale para pedidos a partir de ${brl(c.minTotal)}.`);
  const used = Number(await r.cmd(['GET', K.couponUse(code)])) || 0;
  if (c.maxUses && used >= c.maxUses) fail(400, 'Este cupom já foi totalmente usado.');
  if (user && c.perUser && (Number(await r.cmd(['GET', K.couponUser(code, user.id)])) || 0) >= c.perUser) fail(400, 'Você já usou este cupom o máximo de vezes permitido.');
  if (user && c.firstOrder && (await hasOrders(user.id))) fail(400, 'Este cupom vale só para a primeira compra.');
  const discount = c.type === 'percent' ? Math.round((base * c.value) / 100) : Math.min(base, c.value);
  return { code, discount };
}
// Conta o uso do cupom (com checagem de corrida). d = +1 ao criar/reabrir o pedido, -1 ao cancelar/expirar.
async function couponUse(o, d) {
  if (!o.coupon) return;
  await r.cmd([d > 0 ? 'INCR' : 'DECR', K.couponUse(o.coupon)]);
  await r.cmd([d > 0 ? 'INCR' : 'DECR', K.couponUser(o.coupon, o.userId)]);
}
async function takeCoupon(code, userId) {
  const c = await getJ(K.coupon(code));
  const used = Number(await r.cmd(['INCR', K.couponUse(code)])), mine = Number(await r.cmd(['INCR', K.couponUser(code, userId)]));
  if ((c.maxUses && used > c.maxUses) || (c.perUser && mine > c.perUser)) {
    await r.cmd(['DECR', K.couponUse(code)]); await r.cmd(['DECR', K.couponUser(code, userId)]);
    fail(400, c.maxUses && used > c.maxUses ? 'Este cupom já foi totalmente usado.' : 'Você já usou este cupom o máximo de vezes permitido.');
  }
}

/* ---------- Pedidos ---------- */
const OPEN = ['pendente', 'aguardando'];
const hist = (o, by, what) => { (o.history = o.history || []).push({ at: now(), by: by ? by.email || by : 'cliente', what }); };
const saveOrder = (o) => setJ(K.ord(o.id), o);
const orderCode = () => 'CD-' + crypto.randomBytes(4).toString('hex').toUpperCase();

// Pedidos antigos tinham uma só linha, com estoque e entrega no nível do pedido. Converte para o formato novo (em memória; grava ao salvar).
function norm(o) {
  if (!o || o._v === 2) return o;
  o.lines.forEach((l, i) => {
    if (typeof l.delivery === 'string') { l.mode = l.mode || l.delivery; delete l.delivery; }
    if (i === 0) { l.reserved = l.reserved || o.reserved || []; if (o.delivery && !l.delivered) l.delivered = o.delivery; }
    l.reserved = l.reserved || [];
  });
  delete o.reserved; delete o.delivery; o._v = 2;
  return o;
}
const getOrder = async (id) => norm(await getJ(K.ord(str(id, 40)))) || fail(404, 'Pedido não encontrado.');
const mgetOrders = async (ids) => (await mgetJ(ids.map(K.ord))).filter(Boolean).map(norm);

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

// Valida os itens do carrinho e monta as linhas do pedido. Aceita [{ productId, qty }]; repetidos são somados.
async function buildLines(rawItems) {
  const merged = new Map();
  for (const it of (Array.isArray(rawItems) ? rawItems : []).slice(0, 30)) {
    const id = str(it && it.productId, 40);
    if (id) merged.set(id, (merged.get(id) || 0) + int(it.qty, 1, 1, 100));
  }
  if (!merged.size) fail(400, 'Seu carrinho está vazio.');
  if (merged.size > 10) fail(400, 'No máximo 10 produtos diferentes por pedido.');
  const [cats, prods] = await Promise.all([getCats(), mgetJ([...merged.keys()].map(K.prod))]);
  return [...merged.values()].map((q, n) => {
    const p = prods[n], cat = p && cats.find((c) => c.id === p.categoryId);
    if (!p || !p.active || !cat || !cat.active) fail(404, merged.size === 1 ? 'Produto indisponível.' : 'Um dos produtos do carrinho não está mais disponível.');
    return { pid: p.id, name: p.name, unit: p.price, qty: Math.min(q, p.maxPerOrder || 10), catId: cat.id, catName: cat.name, section: cat.section, mode: p.delivery, link: p.link || '', warrantyDays: p.warrantyDays || 0 };
  });
}

async function createOrder(user, i, ctx = {}) {
  const cfg = await getCfg();
  if (!bool(i.terms)) fail(400, 'Aceite os Termos de uso e a política de reembolso para continuar.');
  const lines = await buildLines(Array.isArray(i.items) ? i.items : [{ productId: i.productId, qty: i.qty }]);
  const subtotal = lines.reduce((s, l) => s + l.unit * l.qty, 0);
  const cp = await checkCoupon(i.coupon, lines, user);
  const total = Math.max(0, subtotal - (cp ? cp.discount : 0));
  // O PIX exige o CPF de quem paga. Confere antes de reservar estoque. Não é guardado.
  const cpf = digits(i.cpf);
  if (total > 0) {
    if (!isCpf(cpf)) fail(400, 'Informe um CPF válido para gerar o PIX.');
    if (!MP.configured()) { const e = new Error('MISTICPAY_CLIENT_ID e MISTICPAY_CLIENT_SECRET não configurados'); e.setup = true; throw e; }
  }
  const prods = await mgetJ(lines.map((l) => K.prod(l.pid))), done = [];
  try {
    for (let n = 0; n < lines.length; n++) { lines[n].reserved = await reserve(prods[n], lines[n].qty); done.push(n); }
    if (cp) await takeCoupon(cp.code, user.id);
  } catch (e) { for (const n of done) await release(prods[n], lines[n].qty, lines[n].reserved).catch(() => {}); throw e; }
  const o = {
    _v: 2, id: newId(), code: orderCode(), userId: user.id, userName: user.name, userEmail: user.email, status: 'pendente',
    lines, subtotal, discount: cp ? cp.discount : 0, total, coupon: cp ? cp.code : null,
    contact: str(i.contact, 80), note: str(i.note, 300), termsAt: now(), createdAt: now(), expiresAt: now() + cfg.reserveMinutes * 60000, history: [],
  };
  hist(o, user, 'Pedido criado');
  await saveOrder(o);
  await r.cmd(['LPUSH', K.ordList, o.id]);
  await r.cmd(['LPUSH', K.userOrd(user.id), o.id]);
  await r.cmd(['SADD', K.pend, o.id]);
  if (total === 0) return markPaid(o, 'sistema');
  try { await startPayment(o, cpf, ctx.webhookUrl); }
  catch (e) { try { await closeOpen(o, 'sistema', 'cancelado', 'Não foi possível gerar o PIX'); } catch (_) { /* já tratado */ } throw e; }
  await notify('neworder', { title: `Novo pedido ${o.code}`, text: o.lines.map((l) => `${l.qty}× ${l.name}`).join('\n'), fields: [['Cliente', o.userName], ['Total', brl(o.total)]] }, cfg);
  return o;
}

/* ---------- Pagamento automático (MisticPay) ---------- */
const orderTitle = (o) => (o.lines.length > 1 ? `${o.lines.length} itens` : o.lines[0].name);
// Gera a cobrança PIX do pedido e guarda o código para a página do pedido mostrar.
async function startPayment(o, cpf, webhookUrl) {
  const ch = await MP.createCharge({
    amountCents: o.total, orderId: o.id, payerName: str(o.userName, 60), payerDocument: cpf,
    description: `Pedido ${o.code} - ${orderTitle(o)}`.slice(0, 120), webhookUrl,
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
  const direct = norm(await getJ(K.ord(ref)));
  if (direct) return direct;
  const id = await r.cmd(['GET', K.pay(ref)]);
  return id ? norm(await getJ(K.ord(id))) : null;
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
    const issue = async (msg) => {
      fresh.payIssue = msg; hist(fresh, 'MisticPay', msg); await saveOrder(fresh); await audit('sistema', 'pagamento:atencao', `${fresh.code}: ${msg}`);
      await notify('attention', { title: `Pedido ${fresh.code} precisa de atenção`, text: msg, tone: 'bad', fields: [['Cliente', fresh.userName], ['Total', brl(fresh.total)]] });
      return fresh;
    };
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
  if (!refused) await notify('attention', { title: `Reembolso no pedido ${o.code}`, text: what, tone: 'bad', fields: [['Cliente', o.userName], ['Total', brl(o.total)]] });
  return o;
}

// Libera a entrega de uma linha e começa a contar a garantia (uma vez só).
function setDelivered(o, i, d) {
  const l = o.lines[i];
  l.delivered = d;
  if (l.warrantyDays && !l.warrantyUntil) l.warrantyUntil = now() + l.warrantyDays * 864e5;
}
// Pedido pago vira "entregue" quando todas as linhas foram entregues.
function syncStatus(o) {
  if (o.status !== 'pago' && o.status !== 'entregue') return;
  const all = o.lines.every((l) => l.delivered);
  o.status = all ? 'entregue' : 'pago';
  if (all && !o.deliveredAt) o.deliveredAt = now();
}

async function markPaid(o, by) {
  if (!['pendente', 'aguardando', 'expirado'].includes(o.status)) fail(409, 'Esse pedido não pode ser marcado como pago.');
  const prods = await mgetJ(o.lines.map((l) => K.prod(l.pid)));
  if (o.status === 'expirado') {
    if (prods.some((p) => !p)) fail(409, 'Um dos produtos foi removido; não dá para reabrir esse pedido.');
    const done = [];
    try { for (let n = 0; n < o.lines.length; n++) { o.lines[n].reserved = await reserve(prods[n], o.lines[n].qty); done.push(n); } }
    catch (e) { for (const n of done) { await release(prods[n], o.lines[n].qty, o.lines[n].reserved).catch(() => {}); o.lines[n].reserved = []; } throw e; }
    await couponUse(o, +1);
    hist(o, by, 'Pedido reaberto');
  }
  o.paidAt = now(); o.status = 'pago'; delete o.payIssue;
  o.lines.forEach((l, n) => {
    if (l.mode === 'items') { setDelivered(o, n, { type: 'items', items: l.reserved || [] }); l.reserved = []; }
    else if (l.mode === 'link') setDelivered(o, n, { type: 'link', url: (prods[n] && prods[n].link) || l.link, downloads: 0 });
  });
  syncStatus(o);
  const manual = o.lines.filter((l) => !l.delivered).length;
  hist(o, by, manual ? `Pagamento confirmado${manual < o.lines.length ? ' e itens automáticos entregues' : ''} (${manual} entrega(s) manual(is) pendente(s))` : 'Pagamento confirmado e produto entregue');
  await saveOrder(o);
  await r.cmd(['SREM', K.pend, o.id]);
  await Promise.all(o.lines.map(async (l, n) => { const p = prods[n]; if (p) { p.sold = (p.sold || 0) + l.qty; await setJ(K.prod(p.id), p); } }));
  if (o.coupon) { await r.cmd(['INCR', K.couponPaidN(o.coupon)]); await r.cmd(['INCRBY', K.couponRev(o.coupon), o.total]); }
  await notify('paid', { title: `Pedido pago ${o.code}`, text: o.lines.map((l) => `${l.qty}× ${l.name}`).join('\n') + (manual ? `\n\nEntrega manual pendente em ${manual} item(ns).` : ''), tone: manual ? 'warn' : 'ok', fields: [['Cliente', o.userName], ['Total', brl(o.total)], ['Contato', o.contact || '—']] });
  await lowStockPing(prods.filter(Boolean));
  return o;
}
// Avisa no Discord quando o estoque de um produto vendido chega no limite (no máximo 1 aviso por produto a cada 6 horas).
async function lowStockPing(prods) {
  const cfg = await getCfg();
  if (!hookUrl(cfg) || cfg.notify.lowstock === false) return;
  const stk = await stockMap(prods);
  for (const p of prods) {
    const s = stk[p.id];
    if (s.unlimited || s.count > cfg.lowStock) continue;
    if ((await r.cmd(['SET', K.lowPing(p.id), '1', 'NX', 'EX', 6 * 3600])) === null) continue;
    await notify('lowstock', { title: s.count === 0 ? `Esgotou: ${p.name}` : `Estoque baixo: ${p.name}`, text: `Restam ${s.count} unidade(s).`, tone: 'warn' }, cfg);
  }
}
async function closeOpen(o, by, status, why) {
  if (!OPEN.includes(o.status)) fail(409, 'Só dá para cancelar pedidos que ainda não foram pagos.');
  const prods = await mgetJ(o.lines.map((l) => K.prod(l.pid)));
  for (let n = 0; n < o.lines.length; n++) { await release(prods[n], o.lines[n].qty, o.lines[n].reserved); o.lines[n].reserved = []; }
  await couponUse(o, -1);
  o.status = status; o.closedAt = now();
  hist(o, by, why);
  await saveOrder(o);
  await r.cmd(['SREM', K.pend, o.id]);
  return o;
}
async function refund(o, by, restock) {
  if (!['pago', 'entregue'].includes(o.status)) fail(409, 'Só dá para reembolsar pedidos pagos.');
  const prods = await mgetJ(o.lines.map((l) => K.prod(l.pid)));
  for (let n = 0; n < o.lines.length; n++) {
    const p = prods[n], l = o.lines[n];
    if (restock && p) await release(p, l.qty, l.delivered && l.delivered.items);
    if (p) { p.sold = Math.max(0, (p.sold || 0) - l.qty); await setJ(K.prod(p.id), p); }
  }
  if (o.coupon) { await r.cmd(['DECR', K.couponPaidN(o.coupon)]); await r.cmd(['DECRBY', K.couponRev(o.coupon), o.total]); }
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
  for (const o of (await mgetOrders(ids))) {
    if (o.status === 'pendente' && o.expiresAt < now()) {
      try {
        if (o.pay) { const c = await confirmPayment(o).catch(() => o); if (c.status !== 'pendente') continue; } // pagou no último minuto
        await closeOpen(o, 'sistema', 'expirado', 'Pedido expirado sem pagamento'); n++;
      } catch (_) { /* outro processo já cuidou */ }
    }
  }
  return n;
}

// Entrega do cliente: links de download nunca aparecem no pedido, só pela rota /download (com prazo e limite).
const lineView = (o, l, cfg) => {
  const { link, reserved, delivered, ...rest } = l;
  const out = { ...rest, warrantyUntil: l.warrantyUntil || 0, delivered: null };
  const visible = o.status === 'pago' || o.status === 'entregue';
  if (visible && delivered) {
    if (delivered.type === 'link') {
      const base = delivered.resetAt || o.paidAt || o.createdAt, d = cfg.download || {};
      out.delivered = { type: 'link', download: true, left: d.max ? Math.max(0, d.max - (delivered.downloads || 0)) : null, until: d.days ? base + d.days * 864e5 : null };
    } else out.delivered = delivered;
  }
  return out;
};
const userOrder = (o, cfg) => {
  const { history, pay, payIssue, adminNote, ...rest } = o;
  const out = { ...rest, lines: o.lines.map((l) => lineView(o, l, cfg)) };
  out.payment = OPEN.includes(o.status) && pay ? { instructions: cfg.pix.instructions, copyPaste: pay.copyPaste, qr: pay.qr || '' } : null;
  return out;
};
const adminOrder = (o) => { const { pay, ...rest } = o; return { ...rest, payRef: pay ? pay.txId : '' }; };
// Entrega a URL do arquivo depois de conferir dono, prazo e limite de downloads.
async function downloadUrl(o, idx) {
  const cfg = await getCfg(), l = o.lines[idx];
  if (!l || !l.delivered || l.delivered.type !== 'link' || !['pago', 'entregue'].includes(o.status)) fail(404, 'Download indisponível.');
  const d = l.delivered, days = cfg.download.days, max = cfg.download.max, base = d.resetAt || o.paidAt || o.createdAt;
  if (days && now() > base + days * 864e5) fail(410, 'O prazo de download deste arquivo acabou. Peça a renovação pelo Suporte.');
  if (max && (d.downloads || 0) >= max) fail(410, 'O limite de downloads deste arquivo foi atingido. Peça a renovação pelo Suporte.');
  const u = url(d.url);
  if (!u) fail(409, 'O link ainda não foi informado. Fale com o suporte.');
  d.downloads = (d.downloads || 0) + 1; d.lastAt = now();
  await saveOrder(o);
  return u;
}
async function listOrders({ status, q, from, to, limit = 300 } = {}) {
  const ids = await r.cmd(['LRANGE', K.ordList, 0, 1999]);
  let list = await mgetOrders(ids);
  const a = dayStart(from), b = dayEnd(to);
  if (status) list = list.filter((o) => o.status === status);
  if (a) list = list.filter((o) => o.createdAt >= a);
  if (b) list = list.filter((o) => o.createdAt <= b);
  if (q) { const t = q.toLowerCase(); list = list.filter((o) => `${o.code} ${o.userName} ${o.userEmail} ${o.contact} ${o.lines.map((l) => l.name).join(' ')}`.toLowerCase().includes(t)); }
  return list.slice(0, limit).map(adminOrder);
}

/* ---------- Usuários ---------- */
const publicUser = (u) => u && { id: u.id, name: u.name, email: u.email, role: u.role, perms: u.role === 'staff' ? (u.perms || []) : [], twofa: !!u.totp, createdAt: u.createdAt };
async function listUsers(q) {
  const ids = await r.cmd(['SMEMBERS', K.users]);
  let us = (await mgetJ(ids.map(K.user))).filter(Boolean);
  if (q) { const t = q.toLowerCase(); us = us.filter((u) => `${u.name} ${u.email}`.toLowerCase().includes(t)); }
  const counts = await r.pipe(us.map((u) => ['LLEN', K.userOrd(u.id)]));
  return us.map((u, i) => ({ id: u.id, name: u.name, email: u.email, role: u.role, perms: u.perms || [], twofa: !!u.totp, banned: !!u.banned, banReason: u.banReason || '', createdAt: u.createdAt, lastLogin: u.lastLogin || 0, orders: Number(counts[i]) || 0 }))
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
const isPaidOrder = (o) => o.status === 'pago' || o.status === 'entregue';
// Parte da receita do pedido que cabe a cada linha (o desconto é rateado na proporção).
const lineRevenue = (o, l) => (o.subtotal ? Math.round(l.unit * l.qty * (o.total / o.subtotal)) : 0);
async function stats() {
  const cfg = await getCfg();
  const ids = await r.cmd(['LRANGE', K.ordList, 0, 2999]);
  const orders = await mgetOrders(ids);
  const [ps, cats, users] = await Promise.all([allProducts(), getCats(), listUsers()]);
  const stk = await stockMap(ps);
  const t = now(), today = dayKey(t);
  const series = [];
  for (let d = 29; d >= 0; d--) series.push({ date: dayKey(t - d * 864e5), revenue: 0, orders: 0 });
  const idx = Object.fromEntries(series.map((s, i) => [s.date, i]));
  const periods = { today: { revenue: 0, orders: 0 }, d7: { revenue: 0, orders: 0 }, d30: { revenue: 0, orders: 0 } };
  const byStatus = {}, bySection = {}, top = {};
  let revenue = 0, paidCount = 0;
  for (const o of orders) {
    byStatus[o.status] = (byStatus[o.status] || 0) + 1;
    if (!isPaidOrder(o)) continue;
    const when = o.paidAt || o.createdAt, age = t - when;
    revenue += o.total; paidCount++;
    const k = dayKey(when);
    if (k in idx) { series[idx[k]].revenue += o.total; series[idx[k]].orders++; }
    if (k === today) { periods.today.revenue += o.total; periods.today.orders++; }
    if (age < 7 * 864e5) { periods.d7.revenue += o.total; periods.d7.orders++; }
    if (age < 30 * 864e5) { periods.d30.revenue += o.total; periods.d30.orders++; }
    for (const l of o.lines) {
      const rev = lineRevenue(o, l);
      (bySection[l.section] = bySection[l.section] || { revenue: 0, orders: 0 });
      bySection[l.section].revenue += rev; bySection[l.section].orders++;
      (top[l.pid] = top[l.pid] || { name: l.name, qty: 0, revenue: 0 });
      top[l.pid].qty += l.qty; top[l.pid].revenue += rev;
    }
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

// Relatório por período: range = 7 | 30 | 90 (últimos dias) ou "mes" (este mês até agora). Compara com o período anterior.
async function report(range) {
  const t = now();
  let from, prevFrom, prevTo, label;
  if (range === 'mes') {
    const d = new Date(t - BRT), y = d.getUTCFullYear(), m = d.getUTCMonth();
    from = Date.UTC(y, m, 1) + BRT; prevFrom = Date.UTC(y, m - 1, 1) + BRT; prevTo = prevFrom + (t - from); label = 'Este mês';
  } else {
    const days = [7, 30, 90].includes(Number(range)) ? Number(range) : 30;
    from = t - days * 864e5; prevFrom = from - days * 864e5; prevTo = from; label = `Últimos ${days} dias`;
  }
  const ids = await r.cmd(['LRANGE', K.ordList, 0, 3999]);
  const [orders, users] = await Promise.all([mgetOrders(ids), listUsers()]);
  const agg = (a, b) => {
    const x = { revenue: 0, paid: 0, created: 0, createdPaid: 0, expired: 0, canceled: 0, refunded: 0, discount: 0, couponOrders: 0 };
    for (const o of orders) {
      if (o.createdAt >= a && o.createdAt < b) { x.created++; if (o.paidAt) x.createdPaid++; if (o.status === 'expirado') x.expired++; if (o.status === 'cancelado') x.canceled++; }
      if (o.status === 'reembolsado' && o.closedAt >= a && o.closedAt < b) x.refunded++;
      if (isPaidOrder(o) && o.paidAt >= a && o.paidAt < b) { x.paid++; x.revenue += o.total; x.discount += o.discount || 0; if (o.coupon) x.couponOrders++; }
    }
    x.avgTicket = x.paid ? Math.round(x.revenue / x.paid) : 0;
    x.conversion = x.created ? Math.round((x.createdPaid / x.created) * 1000) / 10 : 0;   // % dos pedidos criados no período que foram pagos
    x.newUsers = users.filter((u) => u.createdAt >= a && u.createdAt < b).length;
    return x;
  };
  const cur = agg(from, t + 1), prev = agg(prevFrom, prevTo);
  const series = [], idx = {};
  for (let k = dayKey(from), tt = from; k <= dayKey(t); tt += 864e5, k = dayKey(tt)) { idx[k] = series.length; series.push({ date: k, revenue: 0, orders: 0 }); }
  const prod = {}, cat = {}, sec = {};
  for (const o of orders) {
    if (!isPaidOrder(o) || !(o.paidAt >= from)) continue;
    const k = dayKey(o.paidAt);
    if (k in idx) { series[idx[k]].revenue += o.total; series[idx[k]].orders++; }
    for (const l of o.lines) {
      const rev = lineRevenue(o, l);
      (prod[l.pid] = prod[l.pid] || { name: l.name, qty: 0, revenue: 0 }); prod[l.pid].qty += l.qty; prod[l.pid].revenue += rev;
      (cat[l.catId] = cat[l.catId] || { name: l.catName, section: l.section, qty: 0, revenue: 0 }); cat[l.catId].qty += l.qty; cat[l.catId].revenue += rev;
      (sec[l.section] = sec[l.section] || { qty: 0, revenue: 0 }); sec[l.section].qty += l.qty; sec[l.section].revenue += rev;
    }
  }
  const top = (m, n) => Object.values(m).sort((a, b) => b.revenue - a.revenue).slice(0, n);
  return { range: range === 'mes' ? 'mes' : String([7, 30, 90].includes(Number(range)) ? Number(range) : 30), label, from, to: t, cur, prev, series, byProduct: top(prod, 10), byCategory: top(cat, 10), bySection: sec, truncated: ids.length >= 4000 };
}

module.exports = {
  K, SECTIONS, OPEN, newId, getJ, setJ, mgetJ, getCfg, saveCfg, savePages, publicCfg, audit, getCats, saveCategory, deleteCategory,
  listProducts, saveProduct, duplicateProduct, bulkProducts, deleteProduct, stockInfo, stockAction, saveCoupon, listCoupons, couponPayout, checkCoupon, buildLines,
  createOrder, confirmPayment, refreshPayment, findOrderByRef, noteRefund, markPaid, closeOpen, refund, sweepExpired, userOrder, adminOrder, getOrder, mgetOrders, listOrders,
  hist, saveOrder, setDelivered, syncStatus, downloadUrl, reserve, release, norm,
  publicUser, listUsers, getPortfolio, savePortfolio, stats, report, allProducts, stockMap, dayKey,
};
