'use strict';
const http = require('http');
function makeStore(){
 const data=new Map(),now=()=>Date.now(),live=k=>{const e=data.get(k);if(!e)return null;if(e.exp&&e.exp<=now()){data.delete(k);return null}return e};
 const list=(k,create)=>{let e=live(k);if(!e&&create){e={type:'list',v:[],exp:0};data.set(k,e)}return e};
 const cmds={
 PING:()=> 'PONG', GET:k=>{const e=live(k);return e?e.v:null},
 SET:(k,v,...o)=>{const e={type:'str',v:String(v),exp:0};let nx=false;for(let i=0;i<o.length;i++){const f=String(o[i]).toUpperCase();if(f==='EX'){e.exp=now()+Number(o[i+1])*1000;i++}else if(f==='NX')nx=true}if(nx&&live(k))return null;data.set(k,e);return 'OK'},
 MGET:(...ks)=>ks.map(k=>{const e=live(k);return e?e.v:null}),
 INCRBY:(k,n)=>{const e=live(k);const v=(e?Number(e.v):0)+Number(n);data.set(k,{type:'str',v:String(v),exp:e?e.exp:0});return v},
 INCR:k=>cmds.INCRBY(k,1),DECR:k=>cmds.INCRBY(k,-1),DECRBY:(k,n)=>cmds.INCRBY(k,-Number(n)),
 LPUSH:(k,...vs)=>{const e=list(k,true);for(const v of vs)e.v.unshift(String(v));return e.v.length},
 LRANGE:(k,a,b)=>{const e=list(k);if(!e)return [];const n=e.v.length;let s=Number(a),t=Number(b);if(s<0)s=Math.max(0,n+s);if(t<0)t=n+t;return e.v.slice(s,t+1)},
 LREM:(k,c,v)=>{const e=list(k);if(!e)return 0;const i=e.v.indexOf(String(v));if(i<0)return 0;e.v.splice(i,1);return 1},
 SCARD:k=>{const e=live(k);return e?e.v.size:0},
 DEL:(...ks)=>ks.reduce((n,k)=>n+(live(k)?(data.delete(k),1):0),0), EXISTS:k=>live(k)?1:0,
 EXPIRE:(k,s)=>{const e=live(k);if(!e)return 0;e.exp=now()+Number(s)*1000;return 1},
 TTL:k=>{const e=live(k);if(!e)return -2;return e.exp?Math.ceil((e.exp-now())/1000):-1},
 RPUSH:(k,...vs)=>{const e=list(k,true);e.v.push(...vs.map(String));return e.v.length},
 LPOP:k=>{const e=list(k);if(!e||!e.v.length)return null;return e.v.shift()}, LLEN:k=>{const e=list(k);return e?e.v.length:0},
 LTRIM:(k,a,b)=>{const e=list(k);if(!e)return 'OK';const n=e.v.length;let s=Number(a),t=Number(b);if(s<0)s=Math.max(0,n+s);if(t<0)t=n+t;e.v=e.v.slice(s,t+1);return 'OK'},
 SADD:(k,...vs)=>{let e=live(k);if(!e){e={type:'set',v:new Set(),exp:0};data.set(k,e)}let n=0;for(const v of vs)if(!e.v.has(String(v))){e.v.add(String(v));n++}return n},
 SREM:(k,...vs)=>{const e=live(k);if(!e)return 0;let n=0;for(const v of vs)if(e.v.delete(String(v)))n++;return n},
 SMEMBERS:k=>{const e=live(k);return e?[...e.v]:[]}
 };
 const run=cmd=>{const f=cmds[String(cmd[0]).toUpperCase()];if(!f)throw new Error('ERR unknown command '+cmd[0]);return f(...cmd.slice(1))};
 return {run,data};
}
function start(port,token){
 const store=makeStore(),server=http.createServer((req,res)=>{
  const chunks=[];req.on('data',c=>chunks.push(c));req.on('end',()=>{
   const out=(code,body)=>{res.writeHead(code,{'Content-Type':'application/json'});res.end(JSON.stringify(body))};
   if(req.headers.authorization!=='Bearer '+token)return out(401,{error:'Unauthorized'});
   let body;try{body=JSON.parse(Buffer.concat(chunks).toString())}catch(e){return out(400,{error:'bad json'})}
   try{if(req.url==='/pipeline')return out(200,body.map(c=>{try{return {result:store.run(c)}}catch(e){return {error:e.message}}}));return out(200,{result:store.run(body)})}catch(e){return out(400,{error:e.message})}
  });
 });
 return new Promise(r=>server.listen(port,'127.0.0.1',()=>r({server,store})));
}
module.exports={start};
