'use strict';
const W = require('../../wine-lib/wine.js');
module.exports = W.handler({ method: 'GET', who: 'node' }, async (req, res, c, ctx) => {
  if (!(await W.redis(c, ['EXPIRE', W.K(c, 'node', ctx.id), c.nodeTtl]))) return W.send(res, 410, { error: 'session_expired' });
  const wait = W.clamp(W.int(W.queryOf(req).get('wait'), 0), 0, c.maxWait);
  const items = await W.popMany(c, W.K(c, 'q', 'node', ctx.id), wait, 20, 2000000);
  W.send(res, 200, { msgs: items.map(m => ({ h: m.h, p: m.p || '' })), maxwait: c.maxWait, ...(await W.flags(c)) });
});
