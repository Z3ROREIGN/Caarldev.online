'use strict';
// Vincular a conta do Discord (OAuth2, escopo "identify": só lê id, nome e foto; nada de servidores ou e-mail).
// O token do Discord é usado uma única vez e revogado em seguida; o site guarda só id, nome e hash da foto.
const crypto = require('crypto');
const r = require('./redis');
const { fail, str, now } = require('./util');

const API = 'https://discord.com/api/v10';
const K = { state: (s) => `cd:dcs:${s}`, link: (id) => `cd:dc:${id}` };
const STATE_TTL = 600;

const enabled = () => !!(process.env.DISCORD_CLIENT_ID && process.env.DISCORD_CLIENT_SECRET);
function conf() {
  if (!enabled()) { const e = new Error('faltam DISCORD_CLIENT_ID e DISCORD_CLIENT_SECRET'); e.setup = true; throw e; }
  return { id: process.env.DISCORD_CLIENT_ID.trim(), secret: process.env.DISCORD_CLIENT_SECRET.trim() };
}

// Endereço de retorno: precisa ser IGUAL ao cadastrado no Discord Developer Portal (OAuth2 → Redirects).
// Usa o domínio em que a pessoa está (o cookie de login é desse domínio); DISCORD_REDIRECT_URI força outro valor.
function redirectUri(req) {
  if (process.env.DISCORD_REDIRECT_URI) return process.env.DISCORD_REDIRECT_URI.trim();
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
  if (!/^[a-z0-9.-]+(:\d+)?$/i.test(host)) fail(400, 'Não deu para descobrir o endereço do site.');
  const local = /^(localhost|127\.|0\.0\.0\.0)/i.test(host);
  const proto = local ? String(req.headers['x-forwarded-proto'] || 'http').split(',')[0] : 'https';
  return `${proto}://${host}/api/discord/callback`;
}

// Foto: a do perfil ou uma das 6 padrão do Discord. Valida o formato antes de montar o endereço.
function avatarUrl(d, size = 128) {
  if (!d || !/^\d{5,25}$/.test(String(d.id))) return '';
  if (d.avatar && /^(a_)?[0-9a-f]{16,40}$/i.test(d.avatar)) return `https://cdn.discordapp.com/avatars/${d.id}/${d.avatar}.${d.avatar.startsWith('a_') ? 'gif' : 'png'}?size=${size}`;
  return `https://cdn.discordapp.com/embed/avatars/${Number((BigInt(d.id) >> 22n) % 6n)}.png`;
}
// O que o navegador pode ver (sem nada sensível).
const publicDiscord = (d) => d && { id: d.id, name: d.name, username: d.username, avatar: avatarUrl(d), linkedAt: d.linkedAt };

async function begin(user, req) {
  const { id } = conf();
  const state = crypto.randomBytes(24).toString('base64url'), ru = redirectUri(req);
  await r.cmd(['SET', K.state(state), JSON.stringify({ u: user.id, ru }), 'EX', STATE_TTL]);
  const q = new URLSearchParams({ client_id: id, response_type: 'code', redirect_uri: ru, scope: 'identify', state, prompt: 'consent' });
  return `https://discord.com/oauth2/authorize?${q}`;
}
// Cada state vale uma vez só e só para quem o pediu.
async function takeState(state, userId) {
  state = str(state, 80);
  if (!/^[\w-]{20,80}$/.test(state)) return null;
  const raw = await r.cmd(['GET', K.state(state)]);
  if (!raw) return null;
  await r.cmd(['DEL', K.state(state)]);
  let s; try { s = JSON.parse(raw); } catch (_) { return null; }
  return s && s.u === userId ? s : null;
}
async function fetchProfile(code, ru) {
  const { id, secret } = conf();
  let tj = {};
  try {
    const t = await fetch(`${API}/oauth2/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: id, client_secret: secret, grant_type: 'authorization_code', code: str(code, 200), redirect_uri: ru }) });
    tj = await t.json().catch(() => ({}));
    if (!t.ok || !tj.access_token) return null;
    const m = await fetch(`${API}/users/@me`, { headers: { Authorization: `Bearer ${tj.access_token}` } });
    const j = await m.json().catch(() => ({}));
    if (!m.ok || !/^\d{5,25}$/.test(String(j.id))) return null;
    return { id: String(j.id), username: str(j.username, 40), name: str(j.global_name || j.username, 60), avatar: j.avatar && /^(a_)?[0-9a-f]{16,40}$/i.test(j.avatar) ? j.avatar : '', linkedAt: now() };
  } catch (_) { return null; }
  finally {   // o token não é guardado: revoga assim que lê o perfil
    if (tj.access_token) fetch(`${API}/oauth2/token/revoke`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: id, client_secret: secret, token: tj.access_token }) }).catch(() => {});
  }
}
// Uma conta do Discord só pode estar em uma conta da loja. Devolve false se já é de outra.
async function claim(discordId, userId) {
  if ((await r.cmd(['SET', K.link(discordId), userId, 'NX'])) !== null) return true;
  return (await r.cmd(['GET', K.link(discordId)])) === userId;
}
async function release(discordId, userId) {
  if (discordId && (await r.cmd(['GET', K.link(discordId)])) === userId) await r.cmd(['DEL', K.link(discordId)]);
}
module.exports = { enabled, begin, takeState, fetchProfile, claim, release, avatarUrl, publicDiscord, redirectUri };
