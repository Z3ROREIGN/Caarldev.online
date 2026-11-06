const test = require("node:test");
const assert = require("node:assert");
const crypto = require("crypto");
const { verifySignature } = require("../lib/sig");
const { makeFakeRedis, mockReq, mockRes } = require("./fake");

const SECRET = "whsec_teste";
const sign = (ts, body, enc = "hex") => crypto.createHmac("sha256", SECRET).update(`${ts}.${body}`).digest(enc);
const body = '{"id":"evt1","type":"pix.paid","data":{"id":1245}}';

test("assinatura: formatos aceitos", () => {
  const ts = String(Math.floor(Date.now() / 1000));
  const raw = Buffer.from(body);
  const cases = [
    { "x-vaultpay-signature": sign(ts, body), "x-vaultpay-timestamp": ts },
    { "x-vaultpay-signature": `sha256=${sign(ts, body)}`, "x-vaultpay-timestamp": ts },
    { "x-vaultpay-signature": `t=${ts},v1=${sign(ts, body)}` },
    { "x-vaultpay-signature": sign(ts, body, "base64"), "x-vaultpay-timestamp": ts },
  ];
  for (const headers of cases) assert.ok(verifySignature({ secret: SECRET, rawBody: raw, headers }).ok, JSON.stringify(headers));
});

test("assinatura: falha fechada", () => {
  const ts = String(Math.floor(Date.now() / 1000));
  const raw = Buffer.from(body);
  const ok = { "x-vaultpay-signature": sign(ts, body), "x-vaultpay-timestamp": ts };
  assert.ok(!verifySignature({ secret: SECRET, rawBody: Buffer.from(body + " "), headers: ok }).ok);       // corpo alterado
  assert.ok(!verifySignature({ secret: "outro", rawBody: raw, headers: ok }).ok);                          // segredo errado
  assert.ok(!verifySignature({ secret: SECRET, rawBody: raw, headers: { "x-vaultpay-signature": sign(ts, body) } }).ok); // sem timestamp
  assert.ok(!verifySignature({ secret: SECRET, rawBody: raw, headers: {} }).ok);                           // sem assinatura
  assert.ok(!verifySignature({ secret: "", rawBody: raw, headers: ok }).ok);                               // sem segredo
  const old = String(Math.floor(Date.now() / 1000) - 3600);
  assert.ok(!verifySignature({ secret: SECRET, rawBody: raw, headers: { "x-vaultpay-signature": sign(old, body), "x-vaultpay-timestamp": old } }).ok);
});

test("webhook grava, deduplica e o bot lê", async () => {
  const fake = makeFakeRedis();
  process.env.WEBHOOK_SECRET = SECRET;
  process.env.INBOX_SECRET = "segredo-do-bot";
  const webhook = require("../api/webhook");
  const events = require("../api/events");
  const ts = String(Math.floor(Date.now() / 1000));
  const headers = { "x-vaultpay-signature": sign(ts, body), "x-vaultpay-timestamp": ts };

  let res = mockRes();
  await webhook(mockReq("POST", body, headers), res);
  assert.strictEqual(res.code, 200);
  res = mockRes();
  await webhook(mockReq("POST", body, headers), res);                       // reenvio do mesmo evento
  assert.strictEqual(res.body.duplicate, true);
  assert.strictEqual(fake.z.length, 1);

  res = mockRes();
  await events(mockReq("GET", undefined, { authorization: "Bearer errado" }, "/api/events?after=0"), res);
  assert.strictEqual(res.code, 401);
  res = mockRes();
  await events(mockReq("GET", undefined, { authorization: "Bearer segredo-do-bot" }, "/api/events?after=0"), res);
  assert.strictEqual(res.body.items.length, 1);
  assert.strictEqual(res.body.items[0].body, body);
  res = mockRes();
  await events(mockReq("GET", undefined, { authorization: "Bearer segredo-do-bot" }, "/api/events?after=1"), res);
  assert.strictEqual(res.body.items.length, 0);
});

test("webhook rejeita assinatura ruim e registra o motivo (sem expor valores longos)", async () => {
  const fake = makeFakeRedis();
  process.env.WEBHOOK_SECRET = SECRET;
  process.env.INBOX_SECRET = "segredo-do-bot";
  const webhook = require("../api/webhook");
  const events = require("../api/events");
  const res = mockRes();
  await webhook(mockReq("POST", body, { "x-vaultpay-signature": "a".repeat(64) }), res);
  assert.strictEqual(res.code, 401);
  assert.strictEqual(fake.z.length, 0);
  const dbg = mockRes();
  await events(mockReq("GET", undefined, { authorization: "Bearer segredo-do-bot" }, "/api/events?debug=1"), dbg);
  assert.strictEqual(dbg.body.rejected.length, 1);
  assert.match(dbg.body.rejected[0].reason, /timestamp/);
  assert.strictEqual(dbg.body.rejected[0].headers["x-vaultpay-signature"], "<…>");
});
