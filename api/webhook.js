// POST /api/webhook  <- a MisticPay avisa aqui (depósito pago, reembolso, MED).
// O corpo do aviso NUNCA é confiado: só serve para descobrir qual pedido consultar.
// A liberação acontece depois que a própria MisticPay confirma (com a nossa chave) que a cobrança
// está COMPLETA e que o valor cobre o pedido (lib/shop.js → confirmPayment). Repetições são seguras.
const S = require("../lib/shop");

function readBody(req) {
  if (req.body && typeof req.body === "object" && !Buffer.isBuffer(req.body)) return Promise.resolve(req.body);
  if (typeof req.body === "string") { try { return Promise.resolve(JSON.parse(req.body)); } catch (_) { return Promise.resolve(null); } }
  return new Promise((resolve) => {
    const chunks = []; let size = 0;
    req.on("data", (c) => { size += c.length; if (size <= 64 * 1024) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)); });
    req.on("end", () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); } catch (_) { resolve(null); } });
    req.on("error", () => resolve(null));
  });
}

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") return res.status(405).json({ error: "use POST" });
  const body = await readBody(req);
  if (!body || typeof body !== "object") return res.status(400).json({ error: "JSON inválido" });

  try {
    // Infração (MED): só registra para o admin ver no painel.
    if (body.event === "INFRACTION" && body.infraction) {
      const t = body.transaction || {}, i = body.infraction;
      await S.audit("sistema", "pagamento:med", `${String(t.transactionId || "?").slice(0, 60)} · ${String(i.status || "").slice(0, 20)} · ${String(i.type || "").slice(0, 30)}`);
      const o = t.transactionId ? await S.findOrderByRef(t.transactionId) : null;
      if (o && o.pay) { S.hist(o, "MisticPay", `MED (${String(i.status || "").slice(0, 20)}): confira no painel da MisticPay`); o.payIssue = `Infração MED registrada (${String(i.status || "").slice(0, 20)}). Confira no painel da MisticPay.`; await S.saveOrder(o); }
      return res.status(200).json({ ok: true });
    }
    if (String(body.transactionType || "DEPOSITO").toUpperCase() !== "DEPOSITO") return res.status(200).json({ ok: true, ignored: true }); // saques não importam para a loja

    const o = await S.findOrderByRef(body.transactionId);
    if (!o || !o.pay) return res.status(200).json({ ok: true, ignored: true });   // não é nosso: responde 2xx para não ficar reenviando

    const status = String(body.status || "").toUpperCase();
    if (body.refund || status === "DEVOLVIDO" || status === "DEVOLVIDO_PARCIAL") {
      await S.noteRefund(o, body);
      return res.status(200).json({ ok: true });
    }
    const after = await S.confirmPayment(o);
    return res.status(200).json({ ok: true, status: after.status });
  } catch (e) {
    console.error("[webhook]", String((e && e.message) || e));
    return res.status(500).json({ error: "falha ao processar" });   // a MisticPay tenta de novo
  }
};
