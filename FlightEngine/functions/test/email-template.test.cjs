const {test}=require('node:test');
const assert=require('node:assert/strict');
const {renderAlertEmail,googleFlightsLinks}=require('../lib/email-template.js');
const {legDetails,providerName,routeCodes}=require('../lib/flight-display.js');
const fixture=require('./fixtures/rapid-mxp-bcn.json');
const outbound=fixture.data.itineraries.topFlights[0];
function fields(buffer){
 let offset=0;const result={};
 const number=()=>{let value=0,shift=0,byte;do{byte=buffer[offset++];value+=(byte&127)*2**shift;shift+=7;}while(byte&128);return value;};
 while(offset<buffer.length){const tag=number(),field=tag>>3;let value;
  if((tag&7)===2){const size=number();value=buffer.subarray(offset,offset+size);offset+=size;}else{assert.equal(tag&7,0);value=number();}
  (result[field]??=[]).push(value);
 }
 return result;
}
function query(link){return fields(Buffer.from(new URL(link.url).searchParams.get('tfs'),'base64url'));}
function routes(link){return query(link)[3].map(raw=>{const leg=fields(raw);return{from:fields(leg[13][0])[2][0].toString(),to:fields(leg[14][0])[2][0].toString(),date:leg[2][0].toString(),stops:leg[5]?.[0]};});}

test('email sorts prices per person within each cluster, then dates for equal prices',()=>{
 const base={departureDate:'2027-05-20',returnDate:'2027-05-24',totalPrice:400,pricePerPerson:100};
 const offers=[
  {...base,cluster:'B',destinationName:'B cheap',pricePerPerson:1},
  {...base,cluster:'A',destinationName:'A expensive',departureDate:'2027-01-01',pricePerPerson:200},
  {...base,cluster:'A',destinationName:'A cheap later'},
  {...base,cluster:'A',destinationName:'A cheap earlier',departureDate:'2027-04-01',totalPrice:800}
 ];
 const html=renderAlertEmail(offers,'EUR');
 const labels=['A cheap earlier','A cheap later','A expensive','B cheap'];
 for(let i=1;i<labels.length;i++)assert.ok(html.indexOf(labels[i-1])<html.indexOf(labels[i]));
 assert.equal(offers[0].destinationName,'B cheap');
});

test('round-trip link includes airports, both dates, locale and currency in an escaped anchor',()=>{
 const offer={origin:'MXP',destination:'TFS',departureDate:'2027-04-15',returnDate:'2027-04-19',totalPrice:400,pricePerPerson:200,returnDetailsStatus:'NOT_REQUESTED'};
 const links=googleFlightsLinks(offer,'EUR');
 assert.equal(links.length,1);
 const url=new URL(links[0].url);
 assert.equal(url.origin,'https://www.google.com');
 assert.equal(url.pathname,'/travel/flights/search');
 assert.equal(url.searchParams.has('q'),false);
 assert.deepEqual(routes(links[0]),[{from:'MXP',to:'TFS',date:'2027-04-15',stops:undefined},{from:'TFS',to:'MXP',date:'2027-04-19',stops:undefined}]);
 assert.deepEqual(query(links[0])[19],[1]);
 assert.deepEqual([...query(links[0])[8][0]],[1,1]);
 assert.equal(url.searchParams.get('hl'),'it');assert.equal(url.searchParams.get('curr'),'EUR');
 const html=renderAlertEmail([offer],'EUR');
 assert.ok(html.includes('Apri su Google Flights</a>'));
 assert.ok(html.includes('&amp;hl=it&amp;curr=EUR'));
});

test('open-jaw links search the two one-way routes independently',()=>{
 const links=googleFlightsLinks({origin:'MXP',destination:'LIS',returnOrigin:'OPO',returnDestination:'LIN',departureDate:'2027-04-15',returnDate:'2027-04-19',priceType:'SEPARATE_ONE_WAY'},'EUR');
 assert.equal(links.length,2);
 assert.deepEqual(routes(links[0]),[{from:'MXP',to:'LIS',date:'2027-04-15',stops:undefined}]);
 assert.deepEqual(routes(links[1]),[{from:'OPO',to:'LIN',date:'2027-04-19',stops:undefined}]);
 for(const link of links)assert.deepEqual(query(link)[19],[2]);
 assert.equal(googleFlightsLinks({departureDate:'2027-04-15'},'EUR').length,0);
});
test('structured links preserve explicit travelers, economy and zero-stop filters',()=>{
 const [link]=googleFlightsLinks({origin:'MXP',destination:'BCN',departureDate:'2027-05-20',returnDate:'2027-05-24',travelers:4,maxStops:0},'EUR');
 assert.deepEqual([...query(link)[8][0]],[1,1,1,1]);
 assert.deepEqual(query(link)[9],[1]);
 assert.deepEqual(routes(link).map(leg=>leg.stops),[0,0]);
});
test('groups email by cluster and renders itinerary details and totals',()=>{
 const base={cluster:'Weekend Primavera',destinationName:'Barcellona',departureDate:'2027-05-20',returnDate:'2027-05-24',outbound,return:outbound,totalPrice:244,pricePerPerson:61};
 const html=renderAlertEmail([base,{...base,cluster:'Settimana al Mare'},{...base,destinationName:'<script>alert(1)</script>'}],'EUR');
 assert.equal((html.match(/<h2>Weekend Primavera<\/h2>/g)||[]).length,1);
 for(const text of ['Settimana al Mare','20/05/2027','24/05/2027','MXP','BCN','easyJet','U2 7154','TOTALE PER PERSONA:','244,00','61,00','1h 45m'])assert.ok(html.includes(text),text);
 assert.ok(!html.includes('<script>'));assert.ok(html.includes('&lt;script&gt;'));
});
test('provider labels and airport routes are independent',()=>{
 assert.equal(providerName('SerpApi (MXP-BCN) / SerpApi (BCN-MXP)'),'SerpiApi');
 assert.equal(providerName('RapidAPI (MXP-BCN) / SerpApi (BCN-MXP)'),'RapidApi / SerpiApi');
 assert.equal(routeCodes({outbound}),'MXP → BCN');
 assert.equal(legDetails(outbound).origin.time,'20/05/2027 21:35');
 assert.equal(routeCodes({provider:'RapidAPI (MXP-BCN) / RapidAPI (BCN-MXP)'},true),'BCN → MXP');
});

test('round-trip results explain omitted return details without inventing a return flight',()=>{
 const offer={destinationName:'Il Cairo',departureDate:'2027-04-15',returnDate:'2027-04-19',outbound,return:null,returnOrigin:'CAI',returnDestination:'MXP',totalPrice:746,pricePerPerson:186.5,returnDetailsStatus:'NOT_REQUESTED',priceType:'ROUND_TRIP'};
 const html=renderAlertEmail([offer],'EUR');
 assert.ok(html.includes('incluso nel prezzo A/R; dettagli non richiesti'));
 assert.ok(html.includes('CAI'));assert.ok(html.includes('746,00'));
 assert.ok(html.includes('<td colspan="8">Ritorno:'));
 assert.equal((html.match(/U2 7154/g)||[]).length,1);assert.ok(!html.includes('non disponibili'));
 assert.ok(html.includes('<td>19/04/2027</td><td>—</td><td>—</td><td>—</td><td>—</td>'));
 assert.ok(html.includes('<td>(CAI)</td><td>(MXP)</td>'));
});

test('missing and partial flight details retain departure dates and available information',()=>{
 const offer={destinationName:'Tenerife',departureDate:'2027-04-15',returnDate:'2027-04-19',origin:'MXP',destination:'TFS',outbound:null,return:{flights:[{airline:'Test Air',departure_airport:{id:'TFS'},arrival_airport:{id:'MXP'}}]},totalPrice:400,pricePerPerson:200,returnDetailsStatus:'UNAVAILABLE'};
 const html=renderAlertEmail([offer],'EUR');
 assert.ok(html.includes('<td>15/04/2027</td>'));
 assert.ok(html.includes('<td>Test Air</td><td>19/04/2027</td>'));
 assert.ok(html.includes('<td>(TFS)</td><td>(MXP)</td>'));
 assert.ok(!html.includes('0h 0m'));
});

test('open-jaw email identifies two separate one-way flights',()=>{
 const html=renderAlertEmail([{destinationName:'Portogallo',departureDate:'2027-04-15',returnDate:'2027-04-19',outbound,return:outbound,totalPrice:800,pricePerPerson:200,returnDetailsStatus:'OK',priceType:'SEPARATE_ONE_WAY'}],'EUR');
 assert.ok(html.includes('Due voli di sola andata'));assert.ok(html.includes('800,00'));
 assert.ok(!html.includes('dettagli non richiesti'));
});
