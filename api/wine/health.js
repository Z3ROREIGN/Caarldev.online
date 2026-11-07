'use strict';
const W = require('../../wine-lib/wine.js');
module.exports = async (req, res) => {
  const c = W.config();
  let storage = 'missing';
  if (c.redisUrl && c.redisToken) { try { storage = (await W.redis(c, ['PING'])) === 'PONG' ? 'ok' : 'error'; } catch (e) { storage = 'error'; } }
  const tokens = c.botToken.length >= 24 && c.nodeToken.length >= 24 && c.botToken !== c.nodeToken;
  W.send(res, 200, { ok: storage === 'ok' && tokens, wine: 'relay', storage, tokens_ok: tokens, maxwait: c.maxWait });
};
