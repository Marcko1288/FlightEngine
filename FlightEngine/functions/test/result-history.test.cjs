const {test}=require('node:test');
const assert=require('node:assert/strict');
const {latestPerSearch}=require('../lib/result-history.js');
const row=(searchId,runId,ms,price)=>({searchId,runId,checkedAt:{toMillis:()=>ms},pricePerPerson:price});
test('shows best offer of latest execution, not the cheapest historical offer',()=>{
 const rows=[row('a','old',1,10),row('a','new',2,50),row('a','new',2,40),row('b','only',1,99)];
 const latest=latestPerSearch(rows);
 assert.equal(latest.length,2);assert.equal(latest[0].searchId,'a');assert.equal(latest[0].pricePerPerson,40);
 assert.deepEqual(latestPerSearch([...rows].reverse()).map(r=>r.pricePerPerson),[40,99]);
});
test('preserves searches beyond the former 200-result limit and legacy records',()=>{
 const rows=Array.from({length:250},(_,i)=>row(String(i),undefined,i,100));
 assert.equal(latestPerSearch(rows).length,250);
 assert.equal(latestPerSearch([row('a',undefined,1,30),row('a',undefined,2,40)])[0].pricePerPerson,40);
});
