'use strict';
// Utilidades de validação e formatação usadas pela loja.
class HttpError extends Error {
  constructor(status, message, extra) { super(message); this.status = status; this.extra = extra; }
}
const fail = (status, message, extra) => { throw new HttpError(status, message, extra); };
// Texto limpo: sem caracteres de controle, aparado e limitado.
const str = (v, max = 200) => String(v == null ? '' : v).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').trim().slice(0, max);
const int = (v, def = 0, min = -Infinity, max = Infinity) => {
  const n = Math.trunc(Number(v));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def;
};
const bool = (v) => v === true || v === 'true' || v === 1 || v === '1' || v === 'on';
// Só aceita http(s) ou arquivos da pasta assets/. Bloqueia javascript:, data: etc.
const url = (v) => { v = str(v, 700); return /^(https?:\/\/|assets\/)[^\s"'<>]+$/i.test(v) ? v : ''; };
const now = () => Date.now();
const brl = (cents) => (Number(cents) / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const cleanEmail = (v) => str(v, 120).toLowerCase();
const isEmail = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v);
// CPF: 11 dígitos com os dois dígitos verificadores corretos.
const digits = (v) => String(v == null ? '' : v).replace(/\D/g, '');
const isCpf = (v) => {
  const c = digits(v);
  if (c.length !== 11 || /^(\d)\1{10}$/.test(c)) return false;
  for (const n of [9, 10]) {
    let sum = 0;
    for (let i = 0; i < n; i++) sum += Number(c[i]) * (n + 1 - i);
    if (((sum * 10) % 11) % 10 !== Number(c[n])) return false;
  }
  return true;
};
const csvCell = (v) => {
  let s = String(v == null ? '' : v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;          // evita injeção de fórmulas no Excel
  return /[",\n;]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};
module.exports = { HttpError, fail, str, int, bool, url, now, brl, cleanEmail, isEmail, digits, isCpf, csvCell };
