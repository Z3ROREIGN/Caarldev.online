// Cliente mínimo da API REST do Upstash Redis (o Vercel injeta as variáveis ao conectar o banco).
function conf() {
  const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
  if (!url || !token) throw new Error("Banco Redis não conectado (faltam as variáveis REST URL/TOKEN)");
  return { url, token };
}

async function cmd(args) {
  const { url, token } = conf();
  const r = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(args.map(String)),
  });
  const j = await r.json();
  if (!r.ok || j.error) throw new Error(`Redis: ${j.error || r.status}`);
  return j.result;
}

module.exports = { cmd };
