'use strict';
// API falsa da MisticPay para testes e para o servidor local. Só intercepta api.misticpay.com;
// o resto (o Redis falso) passa direto. Opção autoPayMs: a cobrança vira COMPLETO sozinha depois de N ms.
const BASE = 'https://api.misticpay.com/api';
function install({ autoPayMs = 0 } = {}) {
  const real = global.fetch;
  const st = { charges: new Map(), calls: [], failCreate: false, down: false };
  const reply = (status, o) => ({ ok: status < 400, status, json: async () => o });
  global.fetch = async (url, opts = {}) => {
    const u = String(url);
    if (!u.startsWith(BASE)) return real(url, opts);
    if (st.down) throw new Error('rede fora do ar');
    const path = u.slice(BASE.length), body = JSON.parse(opts.body || '{}');
    st.calls.push({ path, body, auth: (opts.headers || {}).Authorization });
    if (path === '/transactions/create') {
      if (st.failCreate) return reply(500, { code: 'INTERNAL_ERROR', message: 'falha', statusCode: 500 });
      const txId = String(31000000 + st.charges.size + 1);
      st.charges.set(String(body.transactionId), { txId, amount: body.amount, state: 'PENDENTE', at: Date.now() });
      return reply(200, { message: 'Transação criada com sucesso', data: { transactionId: txId, transactionAmount: Math.round(body.amount * 100), transactionState: 'PENDENTE', qrCodeBase64: 'data:image/png;base64,iVBORw0KGgo=', copyPaste: `00020101021226-PIX-${body.transactionId}` } });
    }
    if (path === '/transactions/check') {
      const id = String(body.transactionId);
      const c = st.charges.get(id) || [...st.charges.values()].find((x) => x.txId === id);
      if (!c) return reply(404, { code: 'TRANSACTION_NOT_FOUND', message: 'não achei', statusCode: 404 });
      if (autoPayMs && c.state === 'PENDENTE' && Date.now() - c.at >= autoPayMs) c.state = 'COMPLETO';
      return reply(200, { message: 'ok', transaction: { transactionId: id, value: c.paidValue != null ? c.paidValue : c.amount, fee: 0.1, transactionState: c.state, transactionType: 'DEPOSITO' } });
    }
    return reply(404, { code: 'ROUTE_NOT_FOUND', statusCode: 404 });
  };
  st.uninstall = () => { global.fetch = real; };
  return st;
}
module.exports = { install };
