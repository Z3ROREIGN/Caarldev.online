'use strict';
const http = require('http'), path = require('path'), fake = require('./fake-redis');
const BOT = 'bot-token-de-teste-1234567890abcd', NODE = 'node-token-de-teste-1234567890abc', PORT = Number(process.env.PORT || 3000);
(async () => {
  await fake.start(6399, 'redis-teste');
  Object.assign(process.env, { KV_REST_API_URL: 'http://127.0.0.1:6399', KV_REST_API_TOKEN: 'redis-teste', WINE_BOT_TOKEN: BOT, WINE_NODE_TOKEN: NODE });
  const routes = {};
  for (const n of ['connect','up','down','leave','pull','push','state','health']) routes[n] = require(path.join(__dirname, '..', 'api', 'wine', n + '.js'));
  http.createServer((req,res) => {
    const m = /^\/api\/wine\/([a-z]+)/.exec(req.url);
    if (!m || !routes[m[1]]) { res.statusCode=404; return res.end('{}'); }
    const chunks=[]; req.on('data',c=>chunks.push(c));
    req.on('end',()=>{const raw=Buffer.concat(chunks).toString();if(raw&&/json/.test(req.headers['content-type']||'')){try{req.body=JSON.parse(raw)}catch(e){req.body={}}}routes[m[1]](req,res)});
  }).listen(PORT,()=>console.log(`Relay de teste em http://127.0.0.1:${PORT}\nBOT_TOKEN=${BOT}\nNODE_TOKEN=${NODE}`));
})();
