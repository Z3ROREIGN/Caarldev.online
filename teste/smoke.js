'use strict';
const BASE=(process.argv[2]||'http://127.0.0.1:3000').replace(/\/+$/,''),BOT=process.argv[3]||'bot-token-de-teste-1234567890abcd',NODE=process.argv[4]||'node-token-de-teste-1234567890abc',ID='teste-'+Math.random().toString(36).slice(2,8);
let fails=0;
const hBot={Authorization:'Bearer '+BOT,'Content-Type':'application/json'},hNode={Authorization:'Bearer '+NODE,'X-Node-Id':ID,'Content-Type':'application/json'};
async function call(method,path,headers,body){const r=await fetch(BASE+'/api/wine/'+path,{method,headers,body:body===undefined?undefined:JSON.stringify(body)});let j={};try{j=await r.json()}catch(e){}return {s:r.status,j}}
function check(name,cond,extra){console.log((cond?'  OK  ':' FALHA')+' '+name+(cond?'':'  -> '+JSON.stringify(extra)));if(!cond)fails++}
const b64=n=>Buffer.alloc(n,7).toString('base64');
(async()=>{
 console.log('Relay:',BASE,'| PC de teste:',ID);
 let r=await call('GET','health',{});check('health: storage ok e tokens ok',r.j.ok===true,r);
 r=await call('GET','pull',{});check('sem senha -> 401',r.s===401,r);
 r=await call('GET','pull',{Authorization:'Bearer '+NODE});check('token de PC NÃO abre rotas do bot',r.s===401,r);
 r=await call('GET','down',{Authorization:'Bearer '+BOT,'X-Node-Id':ID});check('token do bot NÃO abre rotas de PC',r.s===401,r);
 r=await call('GET','down?wait=0',{Authorization:'Bearer '+NODE,'X-Node-Id':'!!'});check('id de PC inválido -> 400',r.s===400,r);
 r=await call('GET','down?wait=0',hNode);check('PC sem conectar -> 410',r.s===410,r);
 r=await call('POST','push',hBot,{node:ID,msgs:[{h:{t:'ping'}}]});check('bot manda para PC offline -> 404',r.s===404,r);
 r=await call('POST','connect',hNode,{name:'PC Teste',os:'Windows 11',version:'1.0'});check('connect',r.s===200&&r.j.ok,r);
 r=await call('GET','pull?wait=0',hBot);check('bot recebe open do PC',r.s===200&&r.j.items.some(m=>m.n===ID&&m.h.t==='open'),r);check('modo rápido ligado',r.j.burst===true,r.j);
 r=await call('POST','push',hBot,{node:ID,msgs:[{h:{t:'challenge',nonce:'abc'}}]});check('bot -> PC challenge',r.s===200,r);
 r=await call('GET','down?wait=0',hNode);check('PC recebe challenge',r.j.msgs&&r.j.msgs[0]&&r.j.msgs[0].h.nonce==='abc',r);check('PC vê que bot está vivo',r.j.bot===true,r.j);
 const big=b64(300*1024);r=await call('POST','up',hNode,{msgs:[{h:{t:'data',rid:5},p:big}]});check('PC -> bot bloco grande',r.s===200,r);
 r=await call('GET','pull?wait=0',hBot);const got=(r.j.items||[]).find(m=>m.h.t==='data');check('bot recebe bloco intacto',got&&got.p===big&&got.n===ID,r.s);
 r=await call('POST','push',hBot,{node:ID,msgs:[{h:{t:'put',key:'g/a/0',csha:'x',rid:6},p:big}]});check('bot -> PC bloco grande',r.s===200,r);
 r=await call('GET','down?wait=0',hNode);check('PC recebe bloco intacto',r.j.msgs&&r.j.msgs[0]&&r.j.msgs[0].p===big,r.s);
 r=await call('POST','up',hNode,{msgs:[{h:{t:'put'}}]});check('PC não pode se passar pelo bot -> 400',r.s===400,r);
 r=await call('POST','push',hBot,{node:ID,msgs:[{h:{t:'hello'}}]});check('bot não pode se passar por PC -> 400',r.s===400,r);
 r=await call('POST','up',hNode,{msgs:[{h:{t:'data'},p:'A'.repeat(900000)}]});check('mensagem grande demais -> 413',r.s===413,r);
 r=await call('GET','state',hBot);check('state lista PC',r.s===200&&r.j.nodes.some(n=>n.id===ID&&n.name==='PC Teste'),r);
 const t0=Date.now(),waiting=call('GET','down?wait=5',hNode);await new Promise(ok=>setTimeout(ok,1000));await call('POST','push',hBot,{node:ID,msgs:[{h:{t:'ping',rid:9}}]});r=await waiting;const dt=Date.now()-t0;check('long-poll entrega logo',r.j.msgs&&r.j.msgs[0]&&r.j.msgs[0].h.t==='ping'&&dt<2600,{dt,r});
 const t1=Date.now();r=await call('GET','down?wait=2',hNode);check('long-poll vazio volta sozinho',r.s===200&&r.j.msgs.length===0&&Date.now()-t1>=1500,r);
 r=await call('POST','leave',hNode,{});check('leave',r.s===200,r);
 r=await call('GET','pull?wait=0',hBot);check('bot recebe close',r.j.items.some(m=>m.n===ID&&m.h.t==='close'),r);
 r=await call('GET','down?wait=0',hNode);check('depois de sair -> 410',r.s===410,r);
 r=await call('GET','state',hBot);check('state não lista mais PC',!r.j.nodes.some(n=>n.id===ID),r);
 console.log(fails?fails+' teste(s) falharam.':'Tudo certo: o relay está funcionando.');process.exit(fails?1:0);
})().catch(e=>{console.error('Erro:',e.message);process.exit(1)});
