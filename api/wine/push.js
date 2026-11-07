'use strict';
const W = require('../../wine-lib/wine.js');
module.exports = W.handler({ method: 'POST', who: 'bot' }, async (req, res, c) => {
  const b = await W.readJson(req);
  const id = String(b.node || '');
  if (!W.NODE_ID_RE.test(id)) return W.send(res, 400, { error: 'bad_node_id' });
  const v = W.cleanMsgs(c, b.msgs, W.FROM_BOT);
  if (v.error) return W.send(res, v.status, { error: v.error, max: v.max });
  if (!(await W.redis(c, ['EXISTS', W.K(c, 'node', id)]))) return W.send(res, 404, { error: 'node_offline' });
  const q = W.K(c, 'q', 'node', id);
  const cmds = v.msgs.map(m => ['RPUSH', q, JSON.stringify({ h: m.h, p: m.p, ts: Date.now() })]);
  cmds.push(['LTRIM', q, -W.NODE_Q_MAX, -1], ['EXPIRE', q, 300], ['SET', W.K(c, 'burst'), '1', 'EX', 60]);
  await W.pipe(c, cmds);
  W.send(res, 200, { ok: true, accepted: v.msgs.length });
});
