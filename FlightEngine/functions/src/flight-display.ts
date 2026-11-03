import {formatDate} from "./search-data";
export function providerName(value:string){
 return [...new Set((value||"").split(" / ").map(name=>/rapid/i.test(name)?"RapidApi":/serp/i.test(name)?"SerpiApi":name.replace(/\s*\(.*\)/,"").trim()).filter(Boolean))].join(" / ");
}
export function legDetails(raw:any){
 const flights=Array.isArray(raw?.flights)?raw.flights:[];
 const first=flights[0],last=flights[flights.length-1];
 const airport=(a:any)=>({code:a?.airport_code||a?.id||"",name:a?.airport_name||a?.name||"",time:formatDate(a?.time||"")});
 const minutes=(value:any)=>Number(typeof value==="object"?value?.raw:value)||0;
 return{origin:airport(first?.departure_airport),destination:airport(last?.arrival_airport),airlines:flights.map((f:any)=>`${f.airline||""} ${f.flight_number||""}`.trim()),duration:minutes(raw?.total_duration??raw?.duration),stops:raw?.stops??Math.max(0,flights.length-1),layoverMinutes:(Array.isArray(raw?.layovers)?raw.layovers:[]).reduce((sum:number,l:any)=>sum+minutes(l.duration),0)};
}
export function routeCodes(result:any,back=false){
 const details=legDetails(back?result.return:result.outbound);
 const start=details.origin.code||(back?result.returnOrigin:result.origin);
 const end=details.destination.code||(back?result.returnDestination:result.destination);
 if(start&&end)return`${start} → ${end}`;
 const old=String(result.provider||"").match(/\(([A-Z]{3})-([A-Z]{3})\)/g)||[];
 const route=old[back?1:0];return route?route.slice(1,-1).replace("-"," → "):"—";
}
export function durationText(minutes:number){return`${Math.floor(minutes/60)}h ${minutes%60}m`;}
export function returnDescription(result:any){
 if(result.returnDetailsStatus==="NOT_REQUESTED")return`${routeCodes(result,true)} (incluso nel prezzo A/R; dettagli non richiesti)`;
 if(result.returnDetailsStatus==="UNAVAILABLE")return"Dettagli non disponibili al prezzo A/R indicato";
 return routeCodes(result,true);
}
