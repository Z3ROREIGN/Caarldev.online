'use strict';
// Avisos para o Discord (webhook). Nunca derruba a loja: qualquer erro aqui só vai para o log.
// O endereço vem da variável DISCORD_WEBHOOK_URL ou do painel (Configurações > Avisos no Discord).
const { str } = require('./util');

const HOOK = /^https:\/\/(?:(?:canary|ptb)\.)?(?:discord|discordapp)\.com\/api\/webhooks\/\d+\/[\w-]+$/i;
const COLOR = { ok: 0x7bd88f, info: 0xffc83d, warn: 0xff9f43, bad: 0xff5a5a };
const isHook = (u) => HOOK.test(String(u || ''));
const hookUrl = (cfg) => {
  const env = process.env.DISCORD_WEBHOOK_URL || '';
  if (isHook(env)) return env;
  const w = cfg && cfg.notify && cfg.notify.webhook;
  return isHook(w) ? w : '';
};

// event: paid | attention | lowstock | ticket | contact | review | neworder. Cada um liga/desliga em cfg.notify.
async function notify(event, { title, text = '', tone = 'info', fields = [] }, cfgIn) {
  try {
    const cfg = cfgIn || await require('./shop').getCfg();
    const url = hookUrl(cfg);
    if (!url) return false;
    if (cfg.notify && cfg.notify[event] === false) return false;
    const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), 4000);
    try {
      const res = await fetch(url, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: ctl.signal,
        body: JSON.stringify({
          username: `${str(cfg.storeName, 30) || 'Loja'} · avisos`, allowed_mentions: { parse: [] },
          embeds: [{ title: str(title, 200), description: str(text, 1500), color: COLOR[tone] || COLOR.info, timestamp: new Date().toISOString(),
            fields: fields.slice(0, 8).map(([n, v]) => ({ name: str(n, 80), value: str(v, 300) || '—', inline: true })) }],
        }),
      });
      if (!res.ok) console.error('[discord]', res.status);
      return res.ok;
    } finally { clearTimeout(timer); }
  } catch (e) { console.error('[discord]', String((e && e.message) || e)); return false; }
}
module.exports = { notify, isHook, hookUrl };
