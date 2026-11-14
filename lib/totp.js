'use strict';
// Verificação em duas etapas (TOTP, RFC 6238) compatível com Google Authenticator, Authy, Microsoft Authenticator, 1Password...
const crypto = require('crypto');
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function enc(buf) {
  let bits = 0, val = 0, out = '';
  for (const b of buf) { val = (val << 8) | b; bits += 8; while (bits >= 5) { out += B32[(val >>> (bits - 5)) & 31]; bits -= 5; } }
  if (bits > 0) out += B32[(val << (5 - bits)) & 31];
  return out;
}
function dec(s) {
  let bits = 0, val = 0; const out = [];
  for (const ch of String(s).toUpperCase().replace(/[^A-Z2-7]/g, '')) { val = (val << 5) | B32.indexOf(ch); bits += 5; if (bits >= 8) { out.push((val >>> (bits - 8)) & 255); bits -= 8; } }
  return Buffer.from(out);
}
const newSecret = () => enc(crypto.randomBytes(20));
function hotp(key, counter) {
  const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac('sha1', key).update(b).digest(), o = h[19] & 15;
  return String((((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3]) % 1e6).padStart(6, '0');
}
const eq = (a, b) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && crypto.timingSafeEqual(x, y); };
// Devolve o "passo" de 30 s que bateu (para impedir reuso do mesmo código), ou 0 se o código estiver errado.
function verify(secret, code, lastStep = 0, at = Date.now()) {
  code = String(code || '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(code)) return 0;
  const key = dec(secret), step = Math.floor(at / 30000);
  for (const d of [0, -1, 1]) { const s = step + d; if (s > lastStep && eq(hotp(key, s), code)) return s; }
  return 0;
}
const uri = (secret, account, issuer) => `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(account)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
const hashCode = (c) => crypto.createHash('sha256').update(String(c).toLowerCase().replace(/[^a-z0-9]/g, '')).digest('hex');
// 8 códigos de recuperação (uso único). Só o hash fica guardado.
function recoveryCodes() {
  const codes = Array.from({ length: 8 }, () => { const h = crypto.randomBytes(5).toString('hex'); return `${h.slice(0, 5)}-${h.slice(5)}`; });
  return { codes, hashes: codes.map(hashCode) };
}
module.exports = { newSecret, verify, uri, hashCode, recoveryCodes, hotp, dec };
