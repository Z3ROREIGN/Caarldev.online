'use strict';
// Avaliações de produtos (só quem comprou) e lista de favoritos.
const r = require('./redis');
const S = require('./shop');
const { fail, str, int, now, shortName } = require('./util');
const { notify } = require('./notify');

const K = { rv: (pid) => `cd:rv:${pid}`, recent: 'cd:rvr', wl: (uid) => `cd:wl:${uid}` };
const parse = (s) => { try { return JSON.parse(s); } catch (_) { return null; } };
// Upstash devolve HGETALL como lista plana [campo, valor, campo, valor...].
async function hgetall(key) {
  const flat = (await r.cmd(['HGETALL', key])) || [], o = {};
  for (let i = 0; i + 1 < flat.length; i += 2) { const v = parse(flat[i + 1]); if (v) o[flat[i]] = v; }
  return o;
}

async function hasBought(userId, pid) {
  const ids = await r.cmd(['LRANGE', S.K.userOrd(userId), 0, 199]);
  return (await S.mgetOrders(ids)).some((o) => (o.status === 'pago' || o.status === 'entregue') && o.lines.some((l) => l.pid === pid));
}
const summarize = (all) => {
  const vis = Object.values(all).filter((x) => !x.hidden), count = vis.length;
  return { count, avg: count ? Math.round((vis.reduce((s, x) => s + x.rating, 0) / count) * 10) / 10 : 0 };
};
// Guarda a nota média no próprio produto, para a vitrine mostrar sem consultar as avaliações.
async function refreshProduct(pid, all) {
  const p = await S.getJ(S.K.prod(pid));
  if (!p) return;
  const s = summarize(all || await hgetall(K.rv(pid)));
  p.rating = s.avg; p.ratingCount = s.count;
  await S.setJ(S.K.prod(pid), p);
}

async function list(pid, user) {
  pid = str(pid, 40);
  const all = await hgetall(K.rv(pid));
  const reviews = Object.entries(all).filter(([, x]) => !x.hidden).sort((a, b) => b[1].at - a[1].at).slice(0, 50)
    .map(([uid, x]) => ({ name: shortName(x.name), rating: x.rating, text: x.text, at: x.at, reply: x.reply || '', mine: !!user && uid === user.id }));
  const mine = user && all[user.id] ? { rating: all[user.id].rating, text: all[user.id].text, hidden: !!all[user.id].hidden } : null;
  return { reviews, ...summarize(all), mine, canReview: !!user && (!!mine || (await hasBought(user.id, pid))) };
}
async function save(user, b) {
  const pid = str(b.pid, 40), p = await S.getJ(S.K.prod(pid)) || fail(404, 'Produto não encontrado.');
  const rating = int(b.rating, 0, 0, 5);
  if (rating < 1) fail(400, 'Escolha de 1 a 5 estrelas.');
  const old = parse(await r.cmd(['HGET', K.rv(pid), user.id]));
  if (!old && !(await hasBought(user.id, pid))) fail(403, 'Só quem comprou este produto pode avaliar.');
  const rv = { name: user.name, rating, text: str(b.text, 600), at: now(), hidden: old ? !!old.hidden : false, reply: old ? old.reply || '' : '' };
  await r.cmd(['HSET', K.rv(pid), user.id, JSON.stringify(rv)]);
  if (!old) { await r.cmd(['LPUSH', K.recent, `${pid}|${user.id}`]); await r.cmd(['LTRIM', K.recent, 0, 99]); }
  await refreshProduct(pid);
  await notify('review', { title: `${'★'.repeat(rating)}${'☆'.repeat(5 - rating)} em ${p.name}`, text: rv.text, tone: rating >= 4 ? 'ok' : 'warn', fields: [['Cliente', user.name]] });
  return rv;
}
async function remove(pid, uid) {
  pid = str(pid, 40);
  await r.cmd(['HDEL', K.rv(pid), str(uid, 40)]);
  await refreshProduct(pid);
}
// Admin: esconder/mostrar e responder.
async function moderate(pid, uid, { hidden, reply }) {
  pid = str(pid, 40); uid = str(uid, 40);
  const rv = parse(await r.cmd(['HGET', K.rv(pid), uid])) || fail(404, 'Avaliação não encontrada.');
  if (hidden !== undefined) rv.hidden = !!hidden;
  if (reply !== undefined) rv.reply = str(reply, 500);
  await r.cmd(['HSET', K.rv(pid), uid, JSON.stringify(rv)]);
  await refreshProduct(pid);
  return rv;
}
async function adminList() {
  const ps = await S.allProducts();
  const res = await r.pipe(ps.map((p) => ['HGETALL', K.rv(p.id)]));
  const out = [];
  ps.forEach((p, n) => {
    const flat = res[n] || [];
    for (let i = 0; i + 1 < flat.length; i += 2) { const v = parse(flat[i + 1]); if (v) out.push({ pid: p.id, product: p.name, uid: flat[i], ...v }); }
  });
  return out.sort((a, b) => b.at - a.at).slice(0, 300);
}
// Para a página inicial: melhores avaliações recentes (4+ estrelas e com texto).
async function recent(n = 6) {
  const refs = await r.cmd(['LRANGE', K.recent, 0, 59]);
  if (!refs.length) return [];
  const rows = await r.pipe(refs.map((x) => ['HGET', K.rv(x.split('|')[0]), x.split('|')[1]]));
  const pids = [...new Set(refs.map((x) => x.split('|')[0]))];
  const names = Object.fromEntries((await S.mgetJ(pids.map(S.K.prod))).filter(Boolean).filter((p) => p.active).map((p) => [p.id, p.name]));
  const out = [], seen = new Set();
  refs.forEach((x, i) => {
    const [pid, uid] = x.split('|'), v = parse(rows[i]);
    if (!v || v.hidden || v.rating < 4 || v.text.length < 10 || !names[pid] || seen.has(x)) return;
    seen.add(x); out.push({ name: shortName(v.name), rating: v.rating, text: v.text, at: v.at, product: names[pid], pid });
  });
  return out.slice(0, n);
}

/* ---------- Favoritos ---------- */
async function wlToggle(user, pid, on) {
  pid = str(pid, 40);
  if (!on) { await r.cmd(['HDEL', K.wl(user.id), pid]); return { on: false }; }
  const p = await S.getJ(S.K.prod(pid));
  if (!p || !p.active) fail(404, 'Produto indisponível.');
  if ((Number(await r.cmd(['HLEN', K.wl(user.id)])) || 0) >= 100) fail(409, 'Limite de 100 favoritos.');
  const s = (await S.stockMap([p]))[p.id];
  await r.cmd(['HSET', K.wl(user.id), pid, JSON.stringify({ at: now(), out: !s.unlimited && s.count === 0 })]);
  return { on: true };
}
async function wlIds(user) { return Object.keys(await hgetall(K.wl(user.id))); }
// Favoritos com o estado atual; "back" = estava esgotado quando você favoritou e voltou ao estoque.
async function wlList(user) {
  const all = await hgetall(K.wl(user.id)), ids = Object.keys(all);
  if (!ids.length) return [];
  const views = (await S.listProducts({})).filter((p) => ids.includes(p.id));
  return views.map((p) => ({ ...p, back: !!all[p.id].out && !(!p.stock.unlimited && p.stock.count === 0) }));
}
async function wlBack(user) {
  if (!(Number(await r.cmd(['HLEN', K.wl(user.id)])) || 0)) return 0;
  return (await wlList(user)).filter((p) => p.back).length;
}

module.exports = { list, save, remove, moderate, adminList, recent, wlToggle, wlIds, wlList, wlBack, hasBought };
