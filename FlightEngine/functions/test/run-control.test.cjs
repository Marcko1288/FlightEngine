const {test}=require('node:test');
const assert=require('node:assert/strict');
const {startRunControl,RunStopped}=require('../lib/run-control');
function fixture(duration){let next,unsubscribed=false;const ref={id:'test',onSnapshot(callback){next=callback;return()=>{unsubscribed=true;}},update:async()=>{}};const control=startRunControl(ref,duration);return{control,cancel:()=>next({data:()=>({cancelRequestedAt:true})}),closed:()=>unsubscribed};}
test('cancel interrupts the signal and rejects later checkpoints',async()=>{
 const f=fixture(10000);try{await f.control.checkpoint();f.cancel();assert.equal(f.control.signal.aborted,true);await assert.rejects(f.control.checkpoint(),e=>e instanceof RunStopped&&e.status==='CANCELLED');}finally{f.control.close();}assert.equal(f.closed(),true);
});
test('deadline ends execution before the platform timeout',async()=>{
 const f=fixture(5);try{await new Promise(resolve=>f.control.signal.addEventListener('abort',resolve,{once:true}));await assert.rejects(f.control.checkpoint(),e=>e.status==='TIMED_OUT');}finally{f.control.close();}
});
