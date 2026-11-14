'use strict';
// Senhas (scrypt), sessão por cookie assinado (HMAC) e limite de tentativas.
const crypto = require('crypto');
const { promisify } = require('util');
const r = require('./redis');
const { fail } = require('./util');
const scrypt = promisify(crypto.scrypt);
const COOKIE = 'cd_session';
const DAYS = 30;

function secret() {
  const s = process.env.SESSION_SECRET;
  if (!s || s.length < 16) { const e = new Error('SESSION_SECRET não configurado (mínimo 16 caracteres)'); e.setup = true; throw e; }
  return s;
}
const mac = (body) => crypto.createHmac('sha256', secret()).update(body).digest('base64url');
const same = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };

async function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(pw, salt, 64);
  return `s1$${salt.toString('base64url')}$${key.toString('base64url')}`;
}
async function checkPassword(pw, stored) {
  const [v, salt, hash] = String(stored || '').split('$');
  if (v !== 's1' || !salt || !hash) return false;
  const key = await scrypt(pw, Buffer.from(salt, 'base64url'), 64);
  return same(key.toString('base64url'), hash);
}

// E-mails que viram admin automaticamente: variável ADMIN_EMAIL (vários separados por vírgula).
const adminEmails = () => (process.env.ADMIN_EMAIL || '').split(/[,;\s]+/).map((e) => e.trim().toLowerCase()).filter(Boolean);
const isAdminEmail = (email) => adminEmails().includes(String(email).toLowerCase());

function signSession(user) {
  const body = Buffer.from(JSON.stringify({ u: user.id, tv: user.tv || 0, exp: Date.now() + DAYS * 864e5 })).toString('base64url');
  return `${body}.${mac(body)}`;
}
function readSession(token) {
  const [body, sig] = String(token || '').split('.');
  if (!body || !sig || !same(sig, mac(body))) return null;
  try { const p = JSON.parse(Buffer.from(body, 'base64url').toString()); return p.exp > Date.now() ? p : null; } catch (_) { return null; }
}
function cookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) { const i = part.indexOf('='); if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); }
  return out;
}
const secure = (req) => (req.headers['x-forwarded-proto'] || 'https') !== 'http';
function setSession(req, res, user) {
  res.setHeader('Set-Cookie', `${COOKIE}=${encodeURIComponent(signSession(user))}; Path=/; Max-Age=${DAYS * 86400}; HttpOnly; SameSite=Lax${secure(req) ? '; Secure' : ''}`);
}
function clearSession(req, res) {
  res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${secure(req) ? '; Secure' : ''}`);
}
const tokenOf = (req) => cookies(req)[COOKIE];

const ip = (req) => String(req.headers['x-forwarded-for'] || (req.socket && req.socket.remoteAddress) || 'x').split(',')[0].trim();

// Contador com validade: bloqueia depois de "max" ações dentro de "ttl" segundos.
async function limit(key, max, ttl) {
  const k = `cd:rl:${key}`;
  const n = Number(await r.cmd(['INCR', k]));
  if (n === 1) await r.cmd(['EXPIRE', k, ttl]);
  if (n > max) fail(429, 'Muitas tentativas. Aguarde alguns minutos e tente de novo.');
}

// Bloqueio por conta: 10 erros de senha/código em 15 minutos travam o login dessa conta por 15 minutos,
// mesmo que os ataques venham de IPs diferentes. Acertar a senha zera a contagem.
const LOCK_MAX = 10, LOCK_TTL = 900;
const lockKey = (email) => `cd:fail:${email}`;
async function lockCheck(email) {
  if ((Number(await r.cmd(['GET', lockKey(email)])) || 0) >= LOCK_MAX) fail(429, 'Muitas tentativas erradas nessa conta. Por segurança, ela fica travada por 15 minutos.');
}
async function lockFail(email) {
  const n = Number(await r.cmd(['INCR', lockKey(email)]));
  if (n === 1) await r.cmd(['EXPIRE', lockKey(email), LOCK_TTL]);
}
const lockClear = (email) => r.cmd(['DEL', lockKey(email)]);

// Cargos: "admin" faz tudo; "staff" (equipe) só o que o admin liberar em perms.
const PERMS = ['pedidos', 'tickets', 'mensagens', 'estoque', 'produtos', 'cupons', 'portfolio', 'avaliacoes'];
const isStaff = (u) => !!u && (u.role === 'admin' || u.role === 'staff');
const can = (u, perm) => !!u && (u.role === 'admin' || (u.role === 'staff' && Array.isArray(u.perms) && u.perms.includes(perm)));
const canAny = (u, list) => list.some((p) => can(u, p));

module.exports = { same, lockCheck, lockFail, lockClear, PERMS, isStaff, can, canAny, hashPassword, checkPassword, adminEmails, isAdminEmail, signSession, readSession, setSession, clearSession, tokenOf, ip, limit, secret };
