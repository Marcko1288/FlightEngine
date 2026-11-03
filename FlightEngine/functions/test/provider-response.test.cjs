const {test}=require('node:test');
const assert=require('node:assert/strict');
const {parseResponse,serpStops}=require('../lib/provider-response.js');
const response=body=>new Response(JSON.stringify(body));
test('successful MXP-BCN playground response is read as an offer',async()=>{
 const fixture=require('./fixtures/rapid-mxp-bcn.json');
 assert.equal(fixture.data.itineraries.topFlights.length,3);
 assert.equal(fixture.data.itineraries.otherFlights.length,162);
 const result=await parseResponse(response(fixture),'rapid');
 assert.equal(result.status,'OK');assert.equal(result.price,29);
});
test('RapidAPI parameters preserve the configured Italian locale',()=>{
 const {rapidQuery}=require('../lib/rapid-request.js');
 const query=rapidQuery('MXP','BCN','2027-05-20',1,'USD');
 assert.deepEqual(Object.fromEntries(query),{departure_id:'MXP',arrival_id:'BCN',outbound_date:'2027-05-20',travel_class:'ECONOMY',adults:'1',show_hidden:'1',currency:'USD',language_code:'it',country_code:'IT',search_type:'best'});
 const configured=rapidQuery('BCN','MXP','2027-05-24',4,'EUR');
 assert.equal(configured.get('adults'),'4');assert.equal(configured.get('currency'),'EUR');
});
test('max stops uses the SerpApi filter encoding',()=>{
 assert.equal(serpStops(0),'1');assert.equal(serpStops(1),'2');assert.equal(serpStops(2),'3');
});
test('selects cheapest actual offer across both lists, not price insights',async()=>{
 const result=await parseResponse(response({best_flights:[{price:300}],other_flights:[{price:180}],price_insights:{lowest_price:90}}),'serp');
 assert.equal(result.status,'OK');assert.equal(result.price,180);assert.equal(result.raw.price,180);
});
test('provider failures and unexpected schemas are not empty flight results',async()=>{
 for(const body of [{error:'bad request'},{status:false},{data:{flights:[{price:100}]}},{data:{itineraries:{topFlights:[{price:{amount:100}}]}}}]){
  assert.equal((await parseResponse(response(body),'rapid')).status,'ERROR');
 }
 assert.equal((await parseResponse(new Response('',{status:429}),'rapid')).status,'LIMIT');
 assert.equal((await parseResponse(new Response('',{status:403}),'serp')).status,'ERROR');
});
test('reads RapidAPI offers and handles genuine empty lists',async()=>{
 const result=await parseResponse(response({data:{itineraries:{topFlights:[],otherFlights:[{price:'150'}]}}}),'rapid');
 assert.equal(result.status,'OK');assert.equal(result.price,150);
 assert.equal((await parseResponse(response({best_flights:[],other_flights:[]}),'serp')).status,'EMPTY');
});

test('RapidAPI next-flight arrays are parsed and configured stop limits filter fares',async()=>{
 const result=await parseResponse(response({data:{itineraries:[{price:90,stops:2},{price:150,stops:1,next_token:'next'}]}}),'rapid',1);
 assert.equal(result.status,'OK');assert.equal(result.price,150);assert.equal(result.options.length,1);
 assert.equal(result.raw.next_token,'next');
 assert.equal((await parseResponse(response({data:{itineraries:[]}}),'rapid')).status,'EMPTY');
});
