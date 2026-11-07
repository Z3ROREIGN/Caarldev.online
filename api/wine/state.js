'use strict';
const W = require('../../wine-lib/wine.js');
module.exports = W.handler({ method: 'GET', who: 'bot' }, async (req, res, c) => {
  const ids = (await W.redis(c, ['SMEMBERS', W.K(c, 'nodes')])) || [], nodes = [];
  if (ids.length) {
    const cmds = [];
    for (const id of ids) cmds.push(['GET', W.K(c, 'node', id)], ['TTL', W.K(c, 'node', id)], ['LLEN', W.K(c, 'q', 'node', id)]);
    const r = await W.pipe(c, cmds), gone = [];
    ids.forEach((id, i) => {
      const raw = r[i * 3];
      if (raw == null) { gone.push(id); return; }
      let info = {}; try { info = JSON.parse(raw); } catch (e) {}
      const ttl = Number(r[i * 3 + 1]);
      nodes.push({ id, name: info.name || id, os: info.os || '', version: info.version || '', since: info.since || 0, age_s: Math.max(0, c.nodeTtl - (ttl > 0 ? ttl : 0)), queued: Number(r[i * 3 + 2]) || 0 });
    });
    if (gone.length) await W.redis(c, ['SREM', W.K(c, 'nodes'), ...gone]);
  }
  const [botq] = await W.pipe(c, [['LLEN', W.K(c, 'q', 'bot')]]);
  W.send(res, 200, { nodes, bot_queue: Number(botq) || 0, maxwait: c.maxWait, node_ttl: c.nodeTtl, ...(await W.flags(c)) });
});
