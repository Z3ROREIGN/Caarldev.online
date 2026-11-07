'use strict';
const W = require('../../wine-lib/wine.js');
module.exports = W.handler({ method: 'POST', who: 'node' }, async (req, res, c, ctx) => {
  const b = await W.readJson(req), id = ctx.id;
  const info = JSON.stringify({ name: W.str(b.name, 32), os: W.str(b.os, 40), version: W.str(b.version, 20), since: Date.now() });
  await W.pipe(c, [
    ['DEL', W.K(c, 'q', 'node', id)],
    ['SET', W.K(c, 'node', id), info, 'EX', c.nodeTtl],
    ['SADD', W.K(c, 'nodes'), id],
    ['RPUSH', W.K(c, 'q', 'bot'), JSON.stringify({ n: id, h: { t: 'open' }, p: '', ts: Date.now() })],
    ['EXPIRE', W.K(c, 'q', 'bot'), 600],
    ['SET', W.K(c, 'burst'), '1', 'EX', 60],
  ]);
  W.send(res, 200, { ok: true, ttl: c.nodeTtl, maxwait: c.maxWait, ...(await W.flags(c)) });
});
