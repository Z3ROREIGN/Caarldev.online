'use strict';
// Backup e restauração de tudo que a loja guarda no Redis (chaves "cd:*"). O Wine não entra.
const r = require('./redis');
const { fail, now } = require('./util');

// Chaves temporárias (limites de tentativas, travas, avisos) não valem a pena guardar.
const SKIP = /^cd:(rl|fail|plock|pchk|sweep|low):/;
const SKIP_EXACT = new Set(['cd:sweep']);
async function scan() {
  const keys = []; let cur = '0', guard = 0;
  do {
    const [next, ks] = await r.cmd(['SCAN', cur, 'MATCH', 'cd:*', 'COUNT', 500]);
    keys.push(...ks); cur = String(next);
  } while (cur !== '0' && ++guard < 400);
  return [...new Set(keys)].filter((k) => !SKIP.test(k) && !SKIP_EXACT.has(k)).sort();
}
async function dump() {
  const keys = await scan();
  const out = [];
  for (let i = 0; i < keys.length; i += 200) {
    const part = keys.slice(i, i + 200);
    const types = await r.pipe(part.map((k) => ['TYPE', k]));
    const vals = await r.pipe(part.map((k, n) => {
      const t = types[n];
      return t === 'string' ? ['GET', k] : t === 'list' ? ['LRANGE', k, 0, -1] : t === 'set' ? ['SMEMBERS', k] : t === 'hash' ? ['HGETALL', k] : ['TYPE', k];
    }));
    const ttls = await r.pipe(part.map((k) => ['TTL', k]));
    part.forEach((k, n) => {
      const t = types[n];
      if (!['string', 'list', 'set', 'hash'].includes(t)) return;
      let v = vals[n];
      if (t === 'hash') { const o = {}; for (let j = 0; j + 1 < v.length; j += 2) o[v[j]] = v[j + 1]; v = o; }
      out.push({ k, t, v, ttl: Number(ttls[n]) > 0 ? Number(ttls[n]) : 0 });
    });
  }
  return { app: 'caarldev-loja', version: 1, at: now(), count: out.length, keys: out };
}
// Restaura as chaves do arquivo (apaga e recria cada uma; não mexe nas que não estão no arquivo).
async function restore(data) {
  if (!data || data.app !== 'caarldev-loja' || !Array.isArray(data.keys)) fail(400, 'Arquivo de backup inválido.');
  let n = 0;
  for (const e of data.keys) {
    if (!e || typeof e.k !== 'string' || !/^cd:[\w:.@+~-]{1,300}$/.test(e.k) || SKIP.test(e.k)) continue;
    await r.cmd(['DEL', e.k]);
    if (e.t === 'string') await r.cmd(['SET', e.k, String(e.v)]);
    else if (e.t === 'list' && Array.isArray(e.v)) { for (let i = 0; i < e.v.length; i += 200) await r.cmd(['RPUSH', e.k, ...e.v.slice(i, i + 200).map(String)]); }
    else if (e.t === 'set' && Array.isArray(e.v)) { for (let i = 0; i < e.v.length; i += 200) await r.cmd(['SADD', e.k, ...e.v.slice(i, i + 200).map(String)]); }
    else if (e.t === 'hash' && e.v && typeof e.v === 'object') { const f = Object.entries(e.v).flat().map(String); for (let i = 0; i < f.length; i += 200) await r.cmd(['HSET', e.k, ...f.slice(i, i + 200)]); }
    else continue;
    if (e.ttl > 0) await r.cmd(['EXPIRE', e.k, e.ttl]);
    n++;
  }
  return { restored: n };
}
module.exports = { dump, restore };
