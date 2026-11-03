const {test}=require('node:test');
const assert=require('node:assert/strict');
const {keyCandidates,selectKey,beginKeyRun}=require('../lib/key-rotation.js');
const providers=[{name:'SerpApi',keys:['s1','s2']},{name:'RapidAPI',keys:['r1','r2']}];
const keys=keyCandidates(providers);
test('retains the working key and skips exhausted keys across requests',()=>{
 const state={cycle:0,exhausted:[keys[0].id]};
 assert.equal(selectKey(state,keys,new Set()).key.key,'s2');
 assert.equal(selectKey(JSON.parse(JSON.stringify(state)),keys,new Set()).key.key,'s2');
});
test('uses all SerpApi keys before RapidAPI',()=>{
 let state={cycle:0,exhausted:[]};const attempted=new Set();const visited=[];
 for(let i=0;i<4;i++){
  const result=selectKey(state,keys,attempted);visited.push(result.key.key);
  attempted.add(result.key.id);state={...result.state,exhausted:[...result.state.exhausted,result.key.id]};
 }
 assert.deepEqual(visited,['s1','s2','r1','r2']);
 assert.equal(selectKey(state,keys,attempted).key,undefined);
 const next=selectKey(state,keys,new Set());
 assert.equal(next.reset,false);assert.equal(next.state.cycle,0);assert.equal(next.key,undefined);
 const fresh=beginKeyRun(state,keys);
 assert.equal(selectKey(fresh,keys,new Set()).key.key,'s1');
});

test('starts in the middle, wraps once, and stops across dates, tasks and retries',()=>{
 let state=beginKeyRun({cycle:204,exhausted:[keys[0].id]},keys);
 const visited=[];
 for(let i=0;i<4;i++){
  const result=selectKey(state,keys,new Set());visited.push(result.key.key);
  state={...state,exhausted:[...state.exhausted,result.key.id]};
 }
 assert.deepEqual(visited,['s2','r1','r2','s1']);
 for(let i=0;i<362;i++){
  const result=selectKey(JSON.parse(JSON.stringify(state)),keys,new Set());
  assert.equal(result.key,undefined);assert.equal(result.reset,false);
 }
 assert.equal(state.cycle,205);
});
test('new keys are usable and key identity survives reordering',()=>{
 const reordered=keyCandidates([{name:'SerpApi',keys:['s2','s1','new']}]);
 assert.equal(reordered[1].id,keys[0].id);
 const state={cycle:2,exhausted:keys.map(k=>k.id)};
 assert.equal(selectKey(state,reordered,new Set()).key.key,'new');
 assert.equal(selectKey(state,reordered,new Set()).reset,false);
});
test('handles disabled providers, blank and duplicate keys',()=>{
 const rapid=keyCandidates([{name:'RapidAPI',keys:['','r1','r1']}]);
 assert.equal(rapid.length,1);assert.equal(rapid[0].index,2);
 assert.equal(selectKey({cycle:0,exhausted:[]},rapid,new Set()).key.provider,'RapidAPI');
 assert.equal(selectKey({cycle:0,exhausted:[]},[],new Set()).key,undefined);
});
