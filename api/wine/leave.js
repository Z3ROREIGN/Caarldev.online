'use strict';
const W = require('../../wine-lib/wine.js');
module.exports = W.handler({ method: 'POST', who: 'node' }, async (req, res, c, ctx) => {
  const id = ctx.id;
  await W.pipe(c, [
    ['DEL', W.K(c, 'node', id)], ['SREM', W.K(c, 'nodes'), id], ['DEL', W.K(c, 'q', 'node', id)],
    ['RPUSH', W.K(c, 'q', 'bot'), JSON.stringify({ n: id, h: { t: 'close' }, p: '', ts: Date.now() })],
    ['EXPIRE', W.K(c, 'q', 'bot'), 600],
  ]);
  W.send(res, 200, { ok: true });
});
