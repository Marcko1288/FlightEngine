const {test}=require('node:test');
const assert=require('node:assert/strict');
const {redact,bodyChunks,loggedRequest}=require('../lib/request-log.js');
test('redacts credentials in URLs, JSON headers and echoed errors',()=>{
 const source='https://example.test/?api_key=secret-value '+JSON.stringify({'x-rapidapi-key':'secret-value',authorization:'Bearer other-secret','set-cookie':'session=private; Path=/'})+' error secret-value';
 const safe=redact(source,['secret-value']);
 for(const secret of ['secret-value','other-secret','session=private'])assert.ok(!safe.includes(secret));
});
test('large response bodies are preserved across UTF-8 safe chunks',()=>{
 const body='flight € ✈ 😀'.repeat(100000),chunks=bodyChunks(body);
 assert.equal(chunks.join(''),body);
 assert.ok(chunks.every(chunk=>Buffer.byteLength(chunk,'utf8')<500000));
});
function context(){
 const entries=[],bodies=[];
 const entry={set:async value=>entries.push(value),update:async value=>entries.push(value),collection:()=>({doc:()=>({set:async value=>bodies.push(value)})})};
 return{entries,bodies,ctx:{searchId:'search',leg:'ANDATA',runRef:{collection:()=>({doc:()=>entry}),update:async()=>{}}}};
}

test('cancel prevents a provider call from starting',async t=>{
 const {ctx}=context();let called=false;
 t.mock.method(globalThis,'fetch',async()=>{called=true;throw new Error('unexpected');});
 ctx.checkpoint=async()=>{throw new Error('cancelled');};
 await assert.rejects(loggedRequest('https://example.test',{},'rapid',ctx,'private'),/cancelled/);
 assert.equal(called,false);
});

test('cancel aborts an in-flight provider request and records its end',async t=>{
 const {ctx,entries}=context(),controller=new AbortController();ctx.signal=controller.signal;
 t.mock.method(globalThis,'fetch',async(_url,init)=>new Promise((_resolve,reject)=>{init.signal.addEventListener('abort',()=>reject(init.signal.reason),{once:true});controller.abort(new Error('cancelled'));}));
 await assert.rejects(loggedRequest('https://example.test',{},'rapid',ctx,'private'),/cancelled/);
 assert.equal(entries.at(-1).status,'ERROR');assert.ok(entries.at(-1).finishedAt);
});
test('logs failed HTTP response with complete body and HTTP status',async t=>{
 const {entries,bodies,ctx}=context();
 t.mock.method(globalThis,'fetch',async()=>new Response(JSON.stringify({message:'Quota exhausted'}),{status:429}));
 const result=await loggedRequest('https://example.test/?api_key=private',{},'serp',ctx,'private');
 assert.equal(result.status,'LIMIT');assert.equal(entries[0].status,'RUNNING');
 assert.ok(entries.some(x=>x.httpStatus===429));assert.equal(entries.at(-1).status,'LIMIT');
 assert.equal(bodies.map(x=>x.text).join(''),JSON.stringify({message:'Quota exhausted'}));
 assert.ok(!JSON.stringify(entries).includes('private'));
});
test('logs network failures with their cause',async t=>{
 const {entries,ctx}=context();
 t.mock.method(globalThis,'fetch',async()=>{throw new Error('fetch failed',{cause:{code:'ECONNRESET'}})});
 const result=await loggedRequest('https://example.test',{},'rapid',ctx,'private');
 assert.equal(result.status,'ERROR');assert.match(entries.at(-1).message,/ECONNRESET/);
});
