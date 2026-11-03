import {formatDate} from "./search-data";
import {legDetails,durationText,returnDescription} from "./flight-display";
import {googleFlightsSearchUrl} from "./google-flights-link";
export function escapeHtml(value:unknown){return String(value??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]!));}
export function googleFlightsLinks(offer:any,currency:string){
 const out=legDetails(offer.outbound),back=legDetails(offer.return);
 const origin=out.origin.code||offer.origin,destination=out.destination.code||offer.destination;
 const returnOrigin=back.origin.code||offer.returnOrigin||destination,returnDestination=back.destination.code||offer.returnDestination||origin;
 const link=(label:string,from:string,to:string,date:string,returnDate?:string)=>{
  const travelers=offer.travelers??Math.round(offer.totalPrice/offer.pricePerPerson);
  return{label,url:googleFlightsSearchUrl(from,to,date,returnDate,currency,travelers,offer.maxStops)};
 };
 if(offer.priceType==="SEPARATE_ONE_WAY"||returnOrigin!==destination||returnDestination!==origin){
  return[
   ...(origin&&destination&&offer.departureDate?[link("Apri andata su Google Flights",origin,destination,offer.departureDate)]:[]),
   ...(returnOrigin&&returnDestination&&offer.returnDate?[link("Apri ritorno su Google Flights",returnOrigin,returnDestination,offer.returnDate)]:[])
  ];
 }
 return origin&&destination&&offer.departureDate?[link("Apri su Google Flights",origin,destination,offer.departureDate,offer.returnDate)]:[];
}
export function renderAlertEmail(offers:any[],currency:string){
 const esc=escapeHtml,money=(n:number)=>esc(new Intl.NumberFormat("it-IT",{style:"currency",currency}).format(n));
 const groups=new Map<string,any[]>();
 for(const offer of offers){const cluster=offer.cluster||offer.period||"Senza cluster";groups.set(cluster,[...(groups.get(cluster)||[]),offer]);}
 const legRow=(raw:any,date:string,origin:string,destination:string)=>{
  const leg=legDetails(raw),hasFlights=Array.isArray(raw?.flights)&&raw.flights.length>0;
  const airport=(name:string,code:string)=>[esc(name),code?`(${esc(code)})`:""].filter(Boolean).join("<br>")||"—";
  return`<tr><td>${airport(leg.origin.name,leg.origin.code||origin)}</td><td>${airport(leg.destination.name,leg.destination.code||destination)}</td><td>${leg.airlines.filter(Boolean).map(esc).join("<br>")||"—"}</td><td>${esc(leg.origin.time||formatDate(date))||"—"}</td><td>${esc(leg.destination.time)||"—"}</td><td>${raw?.total_duration!=null||raw?.duration!=null?esc(durationText(leg.duration)):"—"}</td><td>${raw?.stops!=null||hasFlights?esc(leg.stops):"—"}</td><td>${Array.isArray(raw?.layovers)?esc(durationText(leg.layoverMinutes)):"—"}</td></tr>`;
 };
 return`<!doctype html><html lang="it"><body style="font-family:Arial,sans-serif;color:#111">${[...groups.entries()].sort(([a],[b])=>a.localeCompare(b)).map(([cluster,items])=>`<h2>${esc(cluster)}</h2>${items.sort((a,b)=>Number(a.pricePerPerson)-Number(b.pricePerPerson)||a.departureDate.localeCompare(b.departureDate)).map(offer=>`<div style="margin:0 0 28px"><p><b>${esc(offer.destinationName)}</b>: ${esc(formatDate(offer.departureDate))} → ${esc(formatDate(offer.returnDate))}${offer.priceType==="SEPARATE_ONE_WAY"?" ? Due voli di sola andata":""}</p><table border="1" cellpadding="6" cellspacing="0" style="border-collapse:collapse;border-color:#bbb;font-size:12px;width:100%;max-width:900px"><thead><tr>${["Città Partenza","Città Arrivo","Compagnia","Partenza","Arrivo","Durata Volo","Scali","Durata Scali"].map(title=>`<th align="left">${title}</th>`).join("")}</tr></thead><tbody>${legRow(offer.outbound,offer.departureDate,offer.origin,offer.destination)}${legRow(offer.return,offer.returnDate,offer.returnOrigin||offer.destination,offer.returnDestination||offer.origin)}${["UNAVAILABLE","NOT_REQUESTED"].includes(offer.returnDetailsStatus)?`<tr><td colspan="8">Ritorno: ${esc(returnDescription(offer))}</td></tr>`:""}<tr><th colspan="7" align="left">TOTALE:</th><td><b>${money(offer.totalPrice)}</b></td></tr><tr><th colspan="7" align="left">TOTALE PER PERSONA:</th><td><b>${money(offer.pricePerPerson)}</b></td></tr></tbody></table><p>${googleFlightsLinks(offer,currency).map(link=>`<a href="${esc(link.url)}" target="_blank" rel="noopener noreferrer" style="display:inline-block;margin:8px 12px 0 0;color:#155eef;font-weight:bold">${esc(link.label)}</a>`).join("")}</p></div>`).join("")}`).join("")}</body></html>`;
}
