import {parseCsv} from "./search-data";
export type CatalogAirport={code:string;name:string;city:string;country:string;region:string;scheduled:boolean;keywords:string};
export type AirportChoice={key:string;value:string;title:string;detail:string;kind:"city"|"airport"};
export const AIRPORT_SOURCE="https://davidmegginson.github.io/ourairports-data/airports.csv";
const fold=(s:string)=>s.normalize("NFD").replace(/[\u0300-\u036f]/g,"").toLowerCase().trim();
export function parseAirportCatalog(csv:string):CatalogAirport[]{
 const rows=parseCsv(csv),headers=rows.shift()||[];
 for(const name of ["iata_code","name","municipality","iso_country","type"])if(!headers.includes(name))throw Error("Formato catalogo aeroporti non valido.");
 const index=(name:string)=>headers.indexOf(name),get=(row:string[],name:string)=>row[index(name)]||"";
 const result=new Map<string,CatalogAirport>();
 for(const row of rows){const code=get(row,"iata_code");if(!/^[A-Z]{3}$/.test(code)||["closed","heliport","seaplane_base","balloonport"].includes(get(row,"type")))continue;
  const airport={code,name:get(row,"name"),city:get(row,"municipality"),country:get(row,"iso_country"),region:get(row,"iso_region"),scheduled:get(row,"scheduled_service")==="yes",keywords:get(row,"keywords")};
  if(!result.has(code)||airport.scheduled)result.set(code,airport);
 }
 return [...result.values()];
}
export function catalogChoices(airports:CatalogAirport[],query:string):AirportChoice[]{
 const q=fold(query);if(q.length<2)return[];
 const countries=new Intl.DisplayNames(["it"],{type:"region"});
 const ranked=airports.map(a=>{const name=fold(a.name),city=fold(a.city),code=fold(a.code);const score=code===q?0:city===q?1:code.startsWith(q)?2:city.startsWith(q)?3:name.includes(q)?4:fold(a.keywords).includes(q)?5:99;return{a,score};}).filter(x=>x.score<99).sort((a,b)=>a.score-b.score||Number(b.a.scheduled)-Number(a.a.scheduled)||a.a.code.localeCompare(b.a.code));
 const groups=new Map<string,CatalogAirport[]>();
 for(const a of airports){if(!a.city||!a.scheduled)continue;const id=`${a.country}:${a.region}:${a.city}`;groups.set(id,[...(groups.get(id)||[]),a]);}
 const cities:AirportChoice[]=[];
 for(const [id,group] of groups){if(group.length<2||!fold(group[0].city).includes(q))continue;const codes=group.map(a=>a.code).sort().join(",");cities.push({key:`city-${id}`,value:codes,title:group[0].city.toUpperCase(),detail:`Tutti gli aeroporti con servizio di linea (${codes}) · ${countries.of(group[0].country)||group[0].country} · ${group[0].region}`,kind:"city"});}
 return[...ranked.filter(x=>x.score===0).map(({a})=>choice(a)),...cities.slice(0,4),...ranked.filter(x=>x.score!==0).slice(0,20).map(({a})=>choice(a))].slice(0,20);
 function choice(a:CatalogAirport):AirportChoice{return{key:`airport-${a.code}`,value:a.code,title:a.code,detail:`${a.city||a.name} — ${a.name} (${countries.of(a.country)||a.country})`,kind:"airport"};}
}
export function resolveCatalogAirport(airports:CatalogAirport[],value:string):string[]{
 const q=fold(value),matches=airports.filter(a=>fold(a.city)===q||fold(a.name)===q);
 const regions=new Set(matches.map(a=>`${a.country}:${a.region}`));
 if(regions.size>1)throw Error(`La località ${value} è ambigua: seleziona i codici IATA dal suggerimento.`);
 return matches.filter(a=>a.scheduled).map(a=>a.code);
}

let cached:CatalogAirport[]|undefined,expiresAt=0,retryAt=0;
let pending:Promise<{airports:CatalogAirport[];stale:boolean}>|undefined;
export async function getAirportCatalog(){
 if(cached&&Date.now()<expiresAt)return{airports:cached,stale:false};
 if(Date.now()<retryAt){if(cached)return{airports:cached,stale:true};throw Error("Catalogo aeroporti temporaneamente non disponibile.");}
 if(pending)return pending;
 pending=(async()=>{try{
  const response=await fetch(AIRPORT_SOURCE,{signal:AbortSignal.timeout(20000)});
  if(!response.ok)throw Error(`Catalogo aeroporti: HTTP ${response.status}`);
  const airports=parseAirportCatalog(await response.text());if(!airports.length)throw Error("Catalogo aeroporti vuoto.");
  cached=airports;expiresAt=Date.now()+24*60*60*1000;return{airports,stale:false};
 }catch(e){retryAt=Date.now()+60000;if(cached)return{airports:cached,stale:true};throw e;}finally{pending=undefined;}})();
 return pending;
}
