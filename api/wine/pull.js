'use strict';
const W = require('../../wine-lib/wine.js');
module.exports = W.handler({ method: 'GET', who: 'bot' }, async (req, res, c) => {
  const q = W.queryOf(req), wait = W.clamp(W.int(q.get('wait'), 0), 0, c.maxWait), max = W.clamp(W.int(q.get('max'), 20), 1, 50);
  await W.redis(c, ['SET', W.K(c, 'botseen'), '1', 'EX', 120]);
  const items = await W.popMany(c, W.K(c, 'q', 'bot'), wait, max, 2000000);
  W.send(res, 200, { items, maxwait: c.maxWait, ...(await W.flags(c)) });
});
