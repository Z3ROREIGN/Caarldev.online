// GET /api/events?after=N  <- só o bot (Bearer INBOX_SECRET). Devolve eventos novos; ?debug=1 mostra rejeitados.
const crypto = require("crypto");
const redis = require("../lib/redis");

function authorized(req) {
  const secret = process.env.INBOX_SECRET;
  if (!secret) return false;
  const got = Buffer.from(String(req.headers.authorization || "").replace(/^Bearer\s+/i, ""));
  const want = Buffer.from(secret);
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "GET") return res.status(405).json({ error: "use GET" });
  if (!authorized(req)) return res.status(401).json({ error: "não autorizado" });
  try {
    const q = new URL(req.url, "http://x").searchParams;
    const after = Math.max(0, parseInt(q.get("after"), 10) || 0);
    const debug = q.get("debug") === "1";
    const rows = await redis.cmd(["ZRANGEBYSCORE", "vp:events", `(${after}`, "+inf", "LIMIT", 0, 50]);
    let items = rows.map((r) => JSON.parse(r));
    if (debug) items = items.map(({ seq, receivedAt }) => ({ seq, receivedAt }));   // sem dados de compradores
    const out = { items };
    if (debug) out.rejected = (await redis.cmd(["LRANGE", "vp:rejected", -20, -1])).map((r) => JSON.parse(r));
    return res.status(200).json(out);
  } catch (e) {
    return res.status(500).json({ error: "falha ao ler" });
  }
};
