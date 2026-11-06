// Confere a assinatura do webhook: HMAC-SHA256(segredo, timestamp + "." + corpoBruto).
// Falha FECHADA: se não achar timestamp/assinatura ou algo não bater, o evento é rejeitado.
const crypto = require("crypto");

const TS_HEADERS = ["x-vaultpay-timestamp", "x-vaultpay-ts", "x-vaultpay-request-timestamp", "x-timestamp"];

function parseHeader(value) {
  const map = {};
  let plain = null;
  for (const part of String(value || "").split(",")) {
    const i = part.indexOf("=");
    if (i > 0 && !/^[A-Za-z0-9+/]+={1,2}$/.test(part.trim())) map[part.slice(0, i).trim().toLowerCase()] = part.slice(i + 1).trim();
    else if (part.trim()) plain = part.trim();
  }
  return { map, plain };
}

function toMillis(ts) {
  if (/^\d+$/.test(ts)) return Number(ts) > 1e12 ? Number(ts) : Number(ts) * 1000;
  const d = Date.parse(ts);
  return Number.isNaN(d) ? null : d;
}

function safeEqual(a, b) {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function verifySignature({ secret, rawBody, headers, now = Date.now(), toleranceSec = 300 }) {
  if (!secret) return { ok: false, reason: "WEBHOOK_SECRET não configurado" };
  const sigHeader = headers["x-vaultpay-signature"];
  if (!sigHeader) return { ok: false, reason: "header X-VaultPay-Signature ausente" };
  const { map, plain } = parseHeader(sigHeader);
  const candidate = map.v1 || map.sha256 || map.signature || map.s || (plain || "").replace(/^sha256=/i, "");
  const ts = map.t || map.timestamp || TS_HEADERS.map((h) => headers[h]).find(Boolean);
  if (!candidate) return { ok: false, reason: "assinatura não encontrada no header" };
  if (!ts) return { ok: false, reason: "timestamp não encontrado (nem no header de assinatura, nem em outro header)" };
  const ms = toMillis(String(ts));
  if (ms === null) return { ok: false, reason: "timestamp em formato desconhecido" };
  if (Math.abs(now - ms) > toleranceSec * 1000) return { ok: false, reason: "timestamp fora da tolerância (possível reenvio)" };

  const mac = crypto.createHmac("sha256", secret).update(Buffer.concat([Buffer.from(`${ts}.`), rawBody]));
  const digest = mac.digest();
  const ok = safeEqual(candidate.toLowerCase(), digest.toString("hex")) || safeEqual(candidate, digest.toString("base64"));
  return ok ? { ok: true } : { ok: false, reason: "assinatura não confere" };
}

module.exports = { verifySignature };
