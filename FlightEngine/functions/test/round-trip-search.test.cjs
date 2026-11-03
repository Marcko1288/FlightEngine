const {test}=require('node:test');
const assert=require('node:assert/strict');
const {normalizeSearch}=require('../lib/search-data');
const {departureDates,tripQueries,flightQueries,plannedRequests,collectRoundTrips}=require('../lib/round-trip-search');
const {tripRequest}=require('../lib/trip-request');
const search=normalizeSearch({origin:'Milano',destination:'BCN',departureFrom:'2027-04-01',departureTo:'2027-05-31',nights:4,travelers:4});
const now=new Date('2026-09-15T12:00:00Z');
const queries=()=>tripQueries(search,departureDates(search,9,now),['MXP','LIN','BGY'],['BCN'],['BCN'],['MXP','LIN','BGY']);
const reply=(price,provider='SerpApi')=>({calls:1,warnings:[],provider,options:[{price,raw:{price,departure_token:'unused-serp',next_token:'unused-rapid'}}]});
const openJaw={origin:'MXP',destination:'FAO',departureDate:'2027-04-01',returnDate:'2027-04-05',returnOrigin:'OPO',returnDestination:'LIN'};

test('61 dates and three airports use 183 calls, with no return lookups or warnings',async()=>{
 const trips=queries(),seen=[];
 const result=await collectRoundTrips(trips,4,3,async q=>{seen.push(q);return reply(800+seen.length-1);});
 assert.equal(result.calls,183);assert.equal(seen.length,183);
 assert.ok(seen.every(q=>q.returnDate&&q.leg==='ANDATA_RITORNO'&&!q.token));
 assert.equal(result.items.length,3);assert.equal(result.items[0].totalPrice,800);
 assert.equal(result.items[0].pricePerPerson,200);
 assert.equal(result.items[0].outboundPrice,null);assert.equal(result.items[0].returnPrice,null);
 assert.equal(result.items[0].returnDetailsStatus,'NOT_REQUESTED');assert.equal(result.items[0].return,null);
 assert.equal(result.items[0].returnOrigin,'BCN');assert.equal(result.items[0].returnDestination,'MXP');
 assert.deepEqual(result.warnings,[]);
 assert.deepEqual(plannedRequests(trips),{priceRequests:183,roundTripRequests:183,oneWayRequests:0,maxReturnDetailRequests:0});
});

test('Cairo March-April weekend search uses exactly 78 calls regardless of result limit',async()=>{
 const s={...search,destination:'CAI',departureFrom:'2027-03-01',departureTo:'2027-04-30',allowedDays:'WEEKEND'};
 const trips=tripQueries(s,departureDates(s,9,now),['MXP','LIN','BGY'],['CAI'],['CAI'],['MXP','LIN','BGY']);
 for(const limit of [1,3,10]){
  let calls=0;const result=await collectRoundTrips(trips,4,limit,async()=>{calls++;return reply(746,'RapidAPI');});
  assert.equal(calls,78);assert.equal(result.calls,78);assert.equal(result.items[0].pricePerPerson,186.5);assert.deepEqual(result.warnings,[]);
 }
});

test('one query can provide all top results without any token follow-ups',async()=>{
 let calls=0;
 const result=await collectRoundTrips(queries().slice(0,1),2,2,async()=>{
  calls++;return{...reply(400),options:[{price:400,raw:{}},{price:150,raw:{next_token:'b'}},{price:100,raw:{next_token:'a'}}]};
 });
 assert.equal(calls,1);assert.deepEqual(result.items.map(x=>x.totalPrice),[100,150]);
});

test('exhaustion stops later dates and retains already observed round-trip fares',async()=>{
 let requests=0;
 const result=await collectRoundTrips(queries(),4,3,async()=>++requests===1?reply(400):{calls:4,options:[],warnings:['exhausted'],exhausted:true});
 assert.equal(requests,2);assert.equal(result.calls,5);assert.equal(result.items[0].totalPrice,400);
 assert.deepEqual(result.warnings,['exhausted']);
});

test('open jaw uses two one-way searches and sums their actual fares and providers',async()=>{
 const seen=[];
 const result=await collectRoundTrips([openJaw],4,3,async q=>{seen.push(q);return reply(q.leg==='ANDATA'?300:500,q.leg==='ANDATA'?'SerpApi':'RapidAPI');});
 assert.deepEqual(seen,[{origin:'MXP',destination:'FAO',departureDate:'2027-04-01',leg:'ANDATA'},{origin:'OPO',destination:'LIN',departureDate:'2027-04-05',leg:'RITORNO'}]);
 assert.equal(result.calls,2);assert.equal(result.items[0].totalPrice,800);assert.equal(result.items[0].pricePerPerson,200);
 assert.equal(result.items[0].outboundPrice,300);assert.equal(result.items[0].returnPrice,500);
 assert.equal(result.items[0].provider,'SerpApi / RapidAPI');assert.equal(result.items[0].priceType,'SEPARATE_ONE_WAY');
 assert.equal(result.items[0].returnDetailsStatus,'OK');assert.equal(result.items[0].return.price,500);
});

test('changing either the return origin or return destination is enough to use one-way flights',()=>{
 for(const trip of [{...openJaw,returnDestination:'MXP'},{...openJaw,returnOrigin:'FAO'}]){
  assert.equal(flightQueries(trip).length,2);assert.ok(flightQueries(trip).every(q=>!q.returnDate));
 }
 assert.equal(flightQueries({...openJaw,returnOrigin:'FAO',returnDestination:'MXP'}).length,1);
});

test('shared outbound and return legs are requested only once across open-jaw combinations',async()=>{
 const trips=[openJaw,{...openJaw,returnDestination:'BGY'},{...openJaw,origin:'VCE'},openJaw];
 const seen=[];const result=await collectRoundTrips(trips,4,3,async q=>{seen.push(q);return reply(100);});
 assert.equal(result.calls,4);assert.equal(seen.length,4);
 assert.deepEqual(plannedRequests(trips),{priceRequests:4,roundTripRequests:0,oneWayRequests:4,maxReturnDetailRequests:0});
});

test('round-trip fares and one-way fares for the same outbound are never mixed in the cache',async()=>{
 const trips=[{...openJaw,returnOrigin:'FAO',returnDestination:'MXP'},openJaw];let calls=0;
 const result=await collectRoundTrips(trips,4,3,async q=>{calls++;return reply(q.returnDate?900:200);});
 assert.equal(calls,3);assert.deepEqual(result.items.map(x=>x.totalPrice),[400,900]);
});

test('ranks combined one-way totals and retains only the configured number of results',async()=>{
 const result=await collectRoundTrips([openJaw],2,2,async q=>({...reply(1),options:(q.leg==='ANDATA'?[900,100,110]:[500,200,220]).map(price=>({price,raw:{price}}))}));
 assert.deepEqual(result.items.map(x=>x.totalPrice),[300,310]);assert.equal(result.calls,2);
});

test('empty outbound skips its return; missing or exhausted return never creates half an itinerary',async()=>{
 let calls=0;
 const empty=await collectRoundTrips([openJaw],4,3,async()=>{calls++;return{calls:1,options:[],warnings:[]};});
 assert.equal(calls,1);assert.equal(empty.items.length,0);
 calls=0;
 const exhausted=await collectRoundTrips([openJaw,{...openJaw,departureDate:'2027-04-02'}],4,3,async()=>++calls===1?reply(100):{calls:1,options:[],warnings:['exhausted'],exhausted:true});
 assert.equal(calls,2);assert.equal(exhausted.items.length,0);assert.deepEqual(exhausted.warnings,['exhausted']);
});

test('dates honor inclusive bounds, existing Thursday-Saturday filter, horizon and past dates',()=>{
 assert.equal(departureDates({...search,allowedDays:'WEEKEND'},9,now).length,27);
 assert.deepEqual(departureDates({...search,departureFrom:'2026-09-14',departureTo:'2026-09-16'},9,now),['2026-09-15','2026-09-16']);
 assert.deepEqual(departureDates({...search,departureFrom:'2027-06-14',departureTo:'2027-06-18'},9,now),['2027-06-14','2027-06-15']);
 const one=tripQueries(search,['2027-12-30'],['MXP'],['BCN'],['BCN'],['MXP']);
 assert.equal(one[0].returnDate,'2028-01-03');
});

test('provider requests use both dates for A/R, only departure for one-way, and never tokens or multi-city',()=>{
 const round=flightQueries(queries()[0])[0],legs=flightQueries(openJaw);
 for(const provider of ['SerpApi','RapidAPI'])for(const q of [round,...legs]){
  const request=tripRequest(provider,'key',q,4,1,'EUR'),url=new URL(request.url),p=url.searchParams;
  assert.equal(p.get('outbound_date'),q.departureDate);assert.equal(p.get('departure_id'),q.origin);assert.equal(p.get('arrival_id'),q.destination);
  assert.equal(p.get('return_date'),q.returnDate||null);assert.equal(p.get('adults'),'4');assert.equal(p.get('currency'),'EUR');
  for(const field of ['departure_token','next_token','multi_city_json'])assert.equal(p.has(field),false);
  if(provider==='SerpApi')assert.equal(p.get('type'),q.returnDate?'1':'2');
  else assert.equal(url.pathname,'/api/v1/searchFlights');
  assert.equal(request.init.method,undefined);assert.equal(request.init.body,undefined);
 }
});
