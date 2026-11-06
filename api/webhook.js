// POST /api/webhook  <- PagVault envia aqui (pix.paid, pix.reversed...)
const crypto = require("crypto");
const { verifySignature } = require("../lib/sig");
const redis = require("../lib/redis");

function readRaw(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

// só headers do gateway; valores longos (assinaturas) são mascarados
function shape(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers)) {
    if (k.startsWith("x-vaultpay") || k === "content-type" || k === "user-agent")
      out[k] = String(v).replace(/[A-Za-z0-9+/_-]{24,}={0,2}/g, "<…>").slice(0, 120);
  }
  return out;
}

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).json({ error: "use POST" });
  const raw = await readRaw(req);
  const v = verifySignature({ secret: process.env.WEBHOOK_SECRET, rawBody: raw, headers: req.headers });

  if (!v.ok) {
    try {
      await redis.cmd(["RPUSH", "vp:rejected", JSON.stringify({ at: Date.now(), reason: v.reason, headers: shape(req.headers) })]);
      await redis.cmd(["LTRIM", "vp:rejected", -20, -1]);
    } catch (_) { /* diagnóstico é opcional */ }
    return res.status(401).json({ error: "assinatura inválida" });
  }

  const key = `vp:dedupe:${crypto.createHash("sha256").update(raw).digest("hex")}`;
  try {
    if ((await redis.cmd(["SET", key, "1", "NX", "EX", 604800])) === null) return res.status(200).json({ ok: true, duplicate: true });
    try {
      const seq = await redis.cmd(["INCR", "vp:seq"]);
      const entry = { seq, receivedAt: Date.now(), verified: true, body: raw.toString("utf8") };
      await redis.cmd(["ZADD", "vp:events", seq, JSON.stringify(entry)]);
      await redis.cmd(["ZREMRANGEBYRANK", "vp:events", 0, -1001]);
    } catch (e) {
      await redis.cmd(["DEL", key]).catch(() => {});      // deixa o PagVault tentar de novo
      throw e;
    }
    return res.status(200).json({ ok: true });
  } catch (e) {
    return res.status(500).json({ error: "falha ao gravar" });
  }
};

module.exports.config = { api: { bodyParser: false } };
