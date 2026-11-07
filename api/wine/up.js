'use strict';
const W = require('../../wine-lib/wine.js');
module.exports = W.handler({ method: 'POST', who: 'node' }, async (req, res, c, ctx) => {
  if (!(await W.redis(c, ['EXPIRE', W.K(c, 'node', ctx.id), c.nodeTtl]))) return W.send(res, 410, { error: 'session_expired' });
  const v = W.cleanMsgs(c, (await W.readJson(req)).msgs, W.FROM_NODE);
  if (v.error) return W.send(res, v.status, { error: v.error, max: v.max });
  const q = W.K(c, 'q', 'bot');
  const cmds = v.msgs.map(m => ['RPUSH', q, JSON.stringify({ n: ctx.id, h: m.h, p: m.p, ts: Date.now() })]);
  cmds.push(['LTRIM', q, -W.BOT_Q_MAX, -1], ['EXPIRE', q, 600]);
  await W.pipe(c, cmds);
  W.send(res, 200, { ok: true, accepted: v.msgs.length });
});
