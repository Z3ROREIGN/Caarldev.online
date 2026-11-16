'use strict';
// Vincular Discord (OAuth simulado, sem rede): node --test teste/discord.test.js
const test = require('node:test');
const assert = require('node:assert');
const fake = require('./fake-redis');

let srv, call, cookie = {}, profile;
test.before(async () => {
  srv = await fake.start(6395, 'dc');
  Object.assign(process.env, { KV_REST_API_URL: 'http://127.0.0.1:6395', KV_REST_API_TOKEN: 'dc', SESSION_SECRET: 'segredo-de-teste-1234567890', ADMIN_EMAIL: 'dono@teste.com', DISCORD_CLIENT_ID: '111', DISCORD_CLIENT_SECRET: 'sec' });
  const real = global.fetch;
  global.fetch = async (u, o) => {
    u = String(u);
    if (u.endsWith('/oauth2/token')) return { ok: true, status: 200, json: async () => ({ access_token: 'tok' }) };
    if (u.endsWith('/oauth2/token/revoke')) return { ok: true, status: 200, json: async () => ({}) };
    if (u.endsWith('/users/@me')) return { ok: true, status: 200, json: async () => profile };
    return real(u, o);
  };
  const handler = require('../api/store.js');
  call = (who, method, route, body, q = '') => new Promise((resolve) => {
    const req = { method, url: `/api/store?r=${route}${q}`, headers: { 'x-requested-with': 'cd', host: 'loja.teste', 'x-forwarded-for': `8.8.${who.length}.1`, cookie: cookie[who] || '' }, body };
    const res = { statusCode: 200, h: {}, setHeader(k, v) { this.h[k.toLowerCase()] = v; }, end(t) {
      if (this.h['set-cookie']) cookie[who] = this.h['set-cookie'].split(';')[0];
      let j; try { j = JSON.parse(t); } catch (_) { j = t; } resolve({ status: this.statusCode, body: j, h: this.h });
    } };
    handler(req, res);
  });
});
test.after(() => srv && srv.server.close());

const stateOf = (loc) => new URL(loc).searchParams.get('state');
test('vincula, mostra no perfil, impede 2ª conta e desvincula', async () => {
  for (const n of ['ana', 'bia']) assert.strictEqual((await call(n, 'POST', 'register', { name: `Cliente ${n}`, email: `${n}@teste.com`, password: 'senha-forte-2' })).status, 200);
  assert.strictEqual((await call('ana', 'GET', 'bootstrap')).body.discordLink, true);
  // sem login: manda entrar
  assert.match((await call('anon', 'GET', 'discord/start')).h.location, /entrar/);
  const s = await call('ana', 'GET', 'discord/start');
  assert.strictEqual(s.status, 302);
  assert.match(s.h.location, /^https:\/\/discord\.com\/oauth2\/authorize\?/);
  assert.match(decodeURIComponent(s.h.location), /redirect_uri=https:\/\/loja\.teste\/api\/discord\/callback/);
  assert.match(s.h.location, /scope=identify/);
  const st = stateOf(s.h.location);
  // state de outra pessoa não vale
  assert.match((await call('bia', 'GET', 'discord/callback', null, `&code=x&state=${st}`)).h.location, /discord=expirado/);
  const s2 = await call('ana', 'GET', 'discord/start'), st2 = stateOf(s2.h.location);
  profile = { id: '80351110224678912', username: 'carl', global_name: 'Carl Dev', avatar: 'a1b2c3d4e5f60718293a4b5c6d7e8f90' };
  const cb = await call('ana', 'GET', 'discord/callback', null, `&code=abc&state=${st2}`);
  assert.match(cb.h.location, /discord=ok/);
  const me = (await call('ana', 'GET', 'bootstrap')).body.user;
  assert.strictEqual(me.discord.username, 'carl');
  assert.match(me.discord.avatar, /^https:\/\/cdn\.discordapp\.com\/avatars\/80351110224678912\/.+\.png/);
  // o mesmo state não vale duas vezes
  assert.match((await call('ana', 'GET', 'discord/callback', null, `&code=abc&state=${st2}`)).h.location, /expirado/);
  // a mesma conta do Discord não entra em outra conta da loja
  const st3 = stateOf((await call('bia', 'GET', 'discord/start')).h.location);
  assert.match((await call('bia', 'GET', 'discord/callback', null, `&code=abc&state=${st3}`)).h.location, /em-uso/);
  // negado no Discord
  const st4 = stateOf((await call('bia', 'GET', 'discord/start')).h.location);
  assert.match((await call('bia', 'GET', 'discord/callback', null, `&error=access_denied&state=${st4}`)).h.location, /negado/);
  // desvincular libera para a outra conta
  assert.strictEqual((await call('ana', 'POST', 'account/discord/unlink', {})).body.user.discord, null);
  const st5 = stateOf((await call('bia', 'GET', 'discord/start')).h.location);
  assert.match((await call('bia', 'GET', 'discord/callback', null, `&code=abc&state=${st5}`)).h.location, /discord=ok/);
});
