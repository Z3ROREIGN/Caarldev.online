'use strict';
// Integração com a MisticPay (PIX). Docs: https://docs.misticpay.com
// - Cobrança:  POST /api/transactions/create  (valor em REAIS, ex.: 4.55)
// - Consulta:  POST /api/transactions/check   (usada para CONFIRMAR todo pagamento)
// Autenticação: chave de acesso pk_/sk_ no header "Authorization: Basic base64(pk:sk)".
// Escopos necessários na chave: TRANSACTION_CREATE e TRANSACTION_READ.
const { HttpError } = require('./util');

const BASE = 'https://api.misticpay.com/api';
const TIMEOUT_MS = 12000;

function auth() {
  const id = process.env.MISTICPAY_CLIENT_ID, secret = process.env.MISTICPAY_CLIENT_SECRET;
  if (!id || !secret) {
    const e = new Error('MISTICPAY_CLIENT_ID e MISTICPAY_CLIENT_SECRET não configurados'); e.setup = true; throw e;
  }
  return 'Basic ' + Buffer.from(`${id}:${secret}`).toString('base64');
}
const configured = () => !!(process.env.MISTICPAY_CLIENT_ID && process.env.MISTICPAY_CLIENT_SECRET);

async function call(path, body) {
  const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  let res, json = {};
  try {
    res = await fetch(BASE + path, { method: 'POST', headers: { Authorization: auth(), 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: ctl.signal });
    try { json = await res.json(); } catch (_) { json = {}; }
  } catch (e) {
    if (e && e.setup) throw e;
    const err = new HttpError(502, 'Não foi possível falar com o serviço de pagamento. Tente de novo em instantes.');
    err.code = 'NETWORK'; throw err;
  } finally { clearTimeout(timer); }
  if (!res.ok) {
    const code = json.code || '';
    console.error('[misticpay]', path, res.status, code, json.requestId || '');
    const err = new HttpError(res.status === 404 ? 404 : 502, 'O pagamento por PIX está indisponível no momento. Tente de novo em instantes.');
    err.code = code; err.upstream = res.status;
    if (res.status === 401 || res.status === 403) { err.setup = true; err.message = `MisticPay recusou a credencial (${code || res.status})`; }
    throw err;
  }
  return json;
}

// Cria a cobrança PIX. amountCents: inteiro em centavos. Devolve só o que o site precisa.
async function createCharge({ amountCents, orderId, payerName, payerDocument, description, webhookUrl }) {
  const body = {
    amount: Math.round(amountCents) / 100,
    payerName, payerDocument, transactionId: orderId, description,
  };
  if (webhookUrl) body.projectWebhook = webhookUrl;
  const j = await call('/transactions/create', body);
  const d = j.data || {};
  const copyPaste = typeof d.copyPaste === 'string' ? d.copyPaste.trim() : '';
  if (!d.transactionId || !copyPaste) throw new HttpError(502, 'O serviço de pagamento não devolveu o código PIX. Tente de novo.');
  const qr = typeof d.qrCodeBase64 === 'string' && /^data:image\/(png|jpeg);base64,[A-Za-z0-9+/=]+$/.test(d.qrCodeBase64) ? d.qrCodeBase64 : '';
  return { txId: String(d.transactionId), copyPaste: copyPaste.slice(0, 1500), qr };
}

// Consulta o estado de uma cobrança. Tenta o id do pedido (o mesmo enviado em transactionId);
// se a MisticPay não achar, tenta o id interno dela.
async function checkCharge(orderId, providerId) {
  const ids = [orderId, providerId].filter(Boolean).map(String);
  let last;
  for (const id of [...new Set(ids)]) {
    try {
      const j = await call('/transactions/check', { transactionId: id });
      const t = j.transaction || j.data || {};
      return {
        state: String(t.transactionState || '').toUpperCase(),
        type: String(t.transactionType || '').toUpperCase(),
        valueCents: Math.round(Number(t.value) * 100),
      };
    } catch (e) { last = e; if (e.upstream !== 404) throw e; }
  }
  throw last;
}

module.exports = { createCharge, checkCharge, configured };
