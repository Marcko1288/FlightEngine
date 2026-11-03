const {test}=require('node:test');
const assert=require('node:assert/strict');
const {parseAirportCatalog,catalogChoices,resolveCatalogAirport}=require('../lib/airport-catalog.js');
const csv=`iata_code,name,municipality,iso_country,iso_region,type,scheduled_service,keywords
TFS,Tenerife South Airport,Granadilla de Abona,ES,ES-CN,large_airport,yes,Tenerife
TFN,Tenerife Norte Airport,La Laguna,ES,ES-CN,large_airport,yes,Tenerife
UBN,Chinggis Khaan International Airport,Ulaanbaatar,MN,MN-047,large_airport,yes,
AAA,First Airport,Example Town,US,US-CA,medium_airport,yes,
AAB,Second Airport,Example Town,US,US-CA,medium_airport,yes,
AAC,Third Airport,Example Town,CA,CA-ON,medium_airport,yes,
OLD,Old Airport,Example Town,US,US-CA,closed,no,
,No IATA Airport,Other,US,US-CA,small_airport,no,
`;
test('loads global IATA airports and finds Tenerife and non-local catalog airports',()=>{
 const airports=parseAirportCatalog(csv);assert.equal(airports.length,6);
 assert.deepEqual(catalogChoices(airports,'tenerife').map(x=>x.value).sort(),['TFN','TFS']);
 assert.equal(catalogChoices(airports,'ubn')[0].value,'UBN');
 assert.equal(catalogChoices(airports,'Ulaanbaatar')[0].value,'UBN');
});
test('groups cities by region and stores airport codes rather than city names',()=>{
 const choices=catalogChoices(parseAirportCatalog(csv),'Example Town');
 const city=choices.find(x=>x.kind==='city');assert.equal(city.value,'AAA,AAB');
 assert.throws(()=>resolveCatalogAirport(parseAirportCatalog(csv),'Example Town'),/ambigua/);
 assert.deepEqual(resolveCatalogAirport(parseAirportCatalog(csv),'Ulaanbaatar'),['UBN']);
});
test('rejects unexpected upstream data and handles short queries',()=>{
 assert.throws(()=>parseAirportCatalog('<html>Error</html>'),/Formato/);
 assert.deepEqual(catalogChoices(parseAirportCatalog(csv),'a'),[]);
});
