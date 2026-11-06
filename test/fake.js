// Redis falso em memória (só os comandos usados) para testar sem rede.
function makeFakeRedis() {
  const kv = new Map(), z = [], lists = new Map();
  async function run(a) {
    const [c, ...r] = a;
    switch (c) {
      case "SET": if (r.includes("NX") && kv.has(r[0])) return null; kv.set(r[0], r[1]); return "OK";
      case "DEL": return kv.delete(r[0]) ? 1 : 0;
      case "INCR": { const n = Number(kv.get(r[0]) || 0) + 1; kv.set(r[0], String(n)); return n; }
      case "ZADD": z.push({ s: Number(r[1]), m: r[2] }); return 1;
      case "ZREMRANGEBYRANK": { z.sort((x, y) => x.s - y.s); const n = z.length, a = Number(r[1]), e = Number(r[2]) < 0 ? n + Number(r[2]) : Number(r[2]); z.splice(a, Math.max(0, e - a + 1)); return 0; }
      case "ZRANGEBYSCORE": { const lo = Number(String(r[1]).replace("(", "")); return z.filter((x) => x.s > lo).sort((x, y) => x.s - y.s).slice(0, Number(r[5])).map((x) => x.m); }
      case "RPUSH": { const l = lists.get(r[0]) || []; l.push(r[1]); lists.set(r[0], l); return l.length; }
      case "LTRIM": { const l = lists.get(r[0]) || []; lists.set(r[0], l.slice(Number(r[1]))); return "OK"; }
      case "LRANGE": return (lists.get(r[0]) || []).slice(Number(r[1]));
      default: throw new Error("comando não suportado: " + c);
    }
  }
  global.fetch = async (_u, opts) => {
    try { return { ok: true, json: async () => ({ result: await run(JSON.parse(opts.body)) }) }; }
    catch (e) { return { ok: false, status: 500, json: async () => ({ error: e.message }) }; }
  };
  process.env.UPSTASH_REDIS_REST_URL = "http://fake";
  process.env.UPSTASH_REDIS_REST_TOKEN = "t";
  return { kv, z, lists };
}

function mockReq(method, body, headers = {}, url = "/") {
  const { Readable } = require("stream");
  const r = Readable.from(body === undefined ? [] : [Buffer.from(body)]);
  r.method = method; r.headers = headers; r.url = url;
  return r;
}

function mockRes() {
  const res = { code: 200, body: null, headers: {} };
  res.status = (c) => { res.code = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  res.setHeader = (k, v) => { res.headers[k] = v; };
  return res;
}

module.exports = { makeFakeRedis, mockReq, mockRes };
