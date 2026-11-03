const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {importSearches,exportSearches,normalizeSearch,formatDate,isoDate}=require('../lib/search-data.js');
const csv=fs.readFileSync(path.join(__dirname,'fixtures/import.csv'),'utf8');
test('imports all 39 rows from the supplied headerless Italian CSV',()=>{
 const rows=importSearches(csv);assert.equal(rows.length,39);
 assert.equal(rows[0].origin,'MILANO');assert.equal(rows[0].destination,'RAK');
 assert.equal(rows[0].departureFrom,'2027-03-01');assert.equal(rows[0].departureTo,'2027-05-31');
 assert.equal(rows[0].destinationName,'Marrakech');assert.equal(rows[0].travelers,4);
 assert.equal(rows[0].cluster,'Weekend Primavera');assert.equal(rows.at(-1).departureTo,'2028-03-05');
});
test('CSV and JSON exports preserve data, dates and quoted clusters on reimport',()=>{
 const rows=importSearches(csv);rows[0].cluster='Gruppo; "Amici"\nPrimavera';rows[1].active=false;
 for(const format of ['csv','json']){
  const exported=exportSearches(rows,format);assert.match(exported,/01\/03\/2027/);
  assert.deepEqual(importSearches(exported,format==='json'),rows);
 }
});
test('accepts legacy period and validates dates and required values',()=>{
 const row=importSearches(csv)[0];delete row.cluster;row.period='Vecchio gruppo';
 assert.equal(normalizeSearch(row).cluster,'Vecchio gruppo');
 assert.throws(()=>normalizeSearch({...row,travelers:0}),/travelers/);
 assert.throws(()=>normalizeSearch({...row,departureFrom:'31/02/2027'}),/Data non valida/);
 assert.throws(()=>importSearches(csv+'\nMilano;BCN'),/colonne/);
 assert.equal(formatDate('2027-03-06 18:35'),'06/03/2027 18:35');
 assert.equal(isoDate('29/02/2028'),'2028-02-29');
});
