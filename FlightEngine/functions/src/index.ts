import {startRunControl,RunStopped} from "./run-control";
import {scheduledSlot} from "./schedule";
import {getAirportCatalog,catalogChoices,resolveCatalogAirport} from "./airport-catalog";
import {createHash} from "node:crypto";
import {normalizeSearch,type SearchConfig} from "./search-data";
import {renderAlertEmail} from "./email-template";
import {providerName,legDetails} from "./flight-display";
import {keyCandidates,selectKey,beginKeyRun,type KeyState} from "./key-rotation";
import {loggedRequest,logEvent,type TraceContext} from "./request-log";
import {collectRoundTrips,departureDates,tripQueries,plannedRequests,type FlightQuery,type TripReply} from "./round-trip-search";
import {tripRequest} from "./trip-request";
import {initializeApp} from "firebase-admin/app";
import {getFunctions} from "firebase-admin/functions";
import {FieldValue,getFirestore,Timestamp,type DocumentReference} from "firebase-admin/firestore";
import {defineJsonSecret,defineSecret} from "firebase-functions/params";
import {onSchedule} from "firebase-functions/v2/scheduler";
import {onCall,HttpsError} from "firebase-functions/v2/https";
import {onTaskDispatched} from "firebase-functions/v2/tasks";
import nodemailer from "nodemailer";
initializeApp(); const db=getFirestore();

const SERPAPI_KEYS=defineJsonSecret<string[]>("SERPAPI_KEYS");
const RAPIDAPI_KEYS=defineJsonSecret<string[]>("RAPIDAPI_KEYS");
const EMAIL_USER=defineSecret("EMAIL_USER");
const EMAIL_APP_PASSWORD=defineSecret("EMAIL_APP_PASSWORD");
type Settings={monthsAhead:number;topResults:number;batchSize:number;dropAlertPercent:number;currency:string;emailTo:string;serpApiEnabled:boolean;rapidApiEnabled:boolean;scheduleTimezone:string;scheduleEnabled:boolean;scheduleHour:number;scheduleMinute:number;scheduleDays:string[];lastScheduleSlot?:string};
type Search=SearchConfig;
const defaults:Settings={monthsAhead:24,topResults:3,batchSize:10,dropAlertPercent:10,currency:"EUR",emailTo:"",serpApiEnabled:true,rapidApiEnabled:true,scheduleTimezone:"Europe/Rome",scheduleEnabled:true,scheduleHour:2,scheduleMinute:30,scheduleDays:["MON","TUE","WED","THU","FRI","SAT","SUN"]};

export const nightlyFlightSearch=onSchedule({schedule:"*/15 * * * *",timeZone:"Europe/Rome",region:"europe-west1",timeoutSeconds:1800,memory:"512MiB"},async event=>{if(await claimScheduledSlot(event.scheduleTime))await enqueueRun();});
export const runFlightSearchNow=onCall({region:"europe-west1",timeoutSeconds:120,memory:"256MiB"},async req=>{if(!req.auth)throw new HttpsError("unauthenticated","Login richiesto");if(req.data?.search){let search:Search;try{search=normalizeSearch(req.data.search)}catch(e:any){throw new HttpsError("invalid-argument",e.message)}return enqueueRun(search,req.auth.uid);}return enqueueRun();});

export const processFlightSearchTask=onTaskDispatched({region:"europe-west1",timeoutSeconds:1800,memory:"512MiB",maxInstances:3,concurrency:1,rateLimits:{maxConcurrentDispatches:3,maxDispatchesPerSecond:1},retryConfig:{maxAttempts:3,minBackoffSeconds:30,maxBackoffSeconds:300},secrets:[SERPAPI_KEYS,RAPIDAPI_KEYS,EMAIL_USER,EMAIL_APP_PASSWORD]},async req=>processSearchTask(req.data,req.context.retryCount));

export const stopFlightSearch=onCall({region:"europe-west1"},async req=>{
 if(!req.auth)throw new HttpsError("unauthenticated","Login richiesto");
 const id=req.data?.runId;if(typeof id!=="string"||! /^[A-Za-z0-9_-]{1,128}$/.test(id))throw new HttpsError("invalid-argument","Esecuzione non valida");
 const ref=db.collection("execution_logs").doc(id);
 await db.runTransaction(async tx=>{const snap=await tx.get(ref);if(!snap.exists)throw new HttpsError("not-found","Esecuzione non trovata");const data=snap.data()!;
 if(!["RUNNING","QUEUED"].includes(data.status))return;
 if(![1,2].includes(data.controlVersion)||(req.data?.archive===true&&data.cancelRequestedAt&&data.heartbeatAt?.toMillis()<Date.now()-5*60000)){tx.update(ref,{status:"INTERRUPTED",finishedAt:FieldValue.serverTimestamp(),error:"Vecchia esecuzione archiviata: arresto del processo non verificabile."});return;}
 tx.update(ref,{cancelRequestedAt:FieldValue.serverTimestamp(),cancelRequestedBy:req.auth!.uid});
 });
 await logEvent({runRef:ref,searchId:""},"Richiesta di arresto / archiviazione ricevuta");return{ok:true};
});
export const searchAirportCatalog=onCall({region:"europe-west1",timeoutSeconds:60,memory:"512MiB"},async req=>{
 if(!req.auth)throw new HttpsError("unauthenticated","Login richiesto");
 const query=String(req.data?.query||"").trim().slice(0,100);if(query.length<2)return{choices:[],stale:false};
 try{const catalog=await getAirportCatalog();return{choices:catalogChoices(catalog.airports,query),stale:catalog.stale};}
 catch{throw new HttpsError("unavailable","Catalogo globale temporaneamente non disponibile. Puoi inserire un codice IATA.");}
});
async function claimScheduledSlot(scheduleTime:string){
 const ref=db.doc("settings/global"),snap=await ref.get(),cfg={...defaults,...snap.data()} as Settings;
 const slot=scheduledSlot(cfg,scheduleTime);
 if(!slot)return false;
 return db.runTransaction(async tx=>{const current=await tx.get(ref);if(current.data()?.lastScheduleSlot===slot)return false;tx.set(ref,{lastScheduleSlot:slot,lastScheduleClaimedAt:FieldValue.serverTimestamp()},{merge:true});return true;});
}

type TaskPayload={runId:string;taskId:string};
async function enqueueRun(immediate?:Search,owner=""){
 const started=Date.now(),runRef=db.collection("execution_logs").doc();
 const cfg={...defaults,...(await db.doc("settings/global").get()).data()} as Settings;
 const entries=immediate?[{id:"immediate_"+createHash("sha256").update(owner+JSON.stringify(immediate)).digest("hex"),search:immediate,saved:false}]:(await db.collection("flight_searches").where("active","==",true).get()).docs.map(d=>({id:d.id,search:normalizeSearch(d.data()),saved:true}));
 await runRef.set({startedAt:FieldValue.serverTimestamp(),status:entries.length?"QUEUED":"WARNING",apiCalls:0,results:0,alerts:0,completedSearches:0,runningSearches:0,queuedSearches:entries.length,failedSearches:0,warningSearches:0,searches:entries.length,logVersion:2,controlVersion:2,mode:immediate?"IMMEDIATE":"SAVED",settings:cfg,...(!entries.length?{finishedAt:FieldValue.serverTimestamp(),durationMs:Date.now()-started,warnings:["Nessuna ricerca attiva salvata."]}:{})});
 await logEvent({runRef,searchId:""},immediate?"Ricerca immediata accodata":"Sotto-task delle ricerche accodati",{count:entries.length,maxConcurrent:3});
 if(!entries.length)return{ok:false,runId:runRef.id,searchIds:[],searches:0,queued:0,warnings:["Nessuna ricerca attiva salvata."]};
 if(!cfg.serpApiEnabled&&!cfg.rapidApiEnabled){await runRef.update({status:"ERROR",finishedAt:FieldValue.serverTimestamp(),error:"Nessun provider abilitato."});throw new HttpsError("failed-precondition","Nessun provider abilitato. Attiva SerpApi o RapidAPI nelle Impostazioni.");}
 const queue=getFunctions().taskQueue<TaskPayload>("locations/europe-west1/functions/processFlightSearchTask");
 try{for(const entry of entries){const taskRef=runRef.collection("tasks").doc(entry.id);await taskRef.set({searchId:entry.id,search:entry.search,saved:entry.saved,status:"QUEUED",createdAt:FieldValue.serverTimestamp(),attempts:0});const id=createHash("sha256").update(runRef.id+":"+entry.id).digest("hex");await queue.enqueue({runId:runRef.id,taskId:entry.id},{id,dispatchDeadlineSeconds:1800});}}
 catch(e:any){await runRef.update({status:"ERROR",finishedAt:FieldValue.serverTimestamp(),error:`Accodamento non riuscito: ${e.message}`,durationMs:Date.now()-started});throw new HttpsError("internal","Impossibile accodare tutte le ricerche.");}
 return{ok:true,runId:runRef.id,searchIds:entries.map(e=>e.id),searches:entries.length,queued:entries.length};
}

async function processSearchTask(payload:TaskPayload,retryCount=0){
 const runRef=db.collection("execution_logs").doc(payload.runId),taskRef=runRef.collection("tasks").doc(payload.taskId),started=Date.now();
 const [runSnap,taskSnap]=await Promise.all([runRef.get(),taskRef.get()]);if(!runSnap.exists||!taskSnap.exists)throw new Error("Sessione o sotto-task non trovato.");
 const run=runSnap.data()!,task=taskSnap.data()!;if(["OK","WARNING","CANCELLED","ERROR"].includes(task.status))return;
 if(run.cancelRequestedAt){await finishTask(runRef,taskRef,{status:"CANCELLED",calls:0,results:0,alerts:0,warnings:[]},started);return;}
 await taskRef.update({status:"RUNNING",startedAt:FieldValue.serverTimestamp(),attempts:FieldValue.increment(1)});await runRef.update({status:"RUNNING",queuedSearches:FieldValue.increment(-1),runningSearches:FieldValue.increment(1),heartbeatAt:FieldValue.serverTimestamp()});
 const control=startRunControl(runRef),search=normalizeSearch(task.search),cfg={...defaults,...run.settings} as Settings,ctx={runRef,searchId:task.searchId,...control};
 try{
  if(!insideHorizon(search.departureFrom,cfg.monthsAhead)){const reason="Data di partenza oltre i mesi di anticipo configurati.";await logEvent(ctx,reason,{search});if(task.saved)await db.doc(`flight_searches/${task.searchId}`).update({lastCheckAt:FieldValue.serverTimestamp(),lastStatus:reason});await finishTask(runRef,taskRef,{status:"WARNING",calls:0,results:0,alerts:0,warnings:[reason]},started);return;}
  await logEvent(ctx,"Avvio sotto-task ricerca",{search});const offers=await searchRoundTrips(search,cfg,ctx);await logEvent(ctx,"Ricerca completata",{calls:offers.calls,results:offers.items.length,warnings:offers.warnings});
  const warnings=[...offers.warnings];if(!offers.calls)warnings.push("Nessuna chiamata effettuata. Controlla date, giorni, aeroporti e chiavi API.");
  const prior=await latestPrice(task.searchId),checkedAt=Timestamp.now(),savedResults=[] as any[];let alerts=0;
  for(const [index,offer] of offers.items.slice(0,Math.max(1,cfg.topResults)).entries()){const out=legDetails(offer.outbound),back=legDetails(offer.return),alert=offer.pricePerPerson<=search.pricePerPerson||isDrop(prior,offer.pricePerPerson,cfg.dropAlertPercent);const result={...offer,provider:providerName(offer.provider),searchId:task.searchId,runId:runRef.id,destinationName:search.destinationName,cluster:search.cluster,currency:cfg.currency,travelers:search.travelers,maxStops:search.maxStops,origin:out.origin.code||search.origin,destination:out.destination.code||search.destination,returnOrigin:back.origin.code||offer.returnOrigin||search.returnOrigin||search.destination,returnDestination:back.destination.code||offer.returnDestination||search.returnDestination||search.origin,checkedAt,alert};await control.checkpoint();await db.collection("flight_results").doc(createHash("sha256").update(`${runRef.id}:${task.searchId}:${index}`).digest("hex")).set(result);savedResults.push(result);if(alert)alerts++;}
  if(task.saved)await db.doc(`flight_searches/${task.searchId}`).update({lastCheckAt:FieldValue.serverTimestamp(),lastStatus:warnings.length?"PROVIDER_WARNING":!offers.calls?"NO_CALLS":offers.items.length?"OK":"NO_FLIGHTS",...(offers.items[0]?{lastPrice:offers.items[0].pricePerPerson,lastPriceCurrency:cfg.currency}:{})});
  await finishTask(runRef,taskRef,{status:warnings.length?"WARNING":"OK",calls:offers.calls,results:savedResults.length,alerts,warnings},started);
 }catch(e:any){const stopped=e instanceof RunStopped;if(stopped&&e.status==="CANCELLED"){await finishTask(runRef,taskRef,{status:"CANCELLED",calls:0,results:0,alerts:0,warnings:[e.message]},started);return;}const message=String(e?.message||e);console.error("flight-task-error",{runId:runRef.id,taskId:taskRef.id,retryCount,error:message});if(retryCount>=2){await finishTask(runRef,taskRef,{status:"ERROR",calls:0,results:0,alerts:0,warnings:[message]},started);return;}await taskRef.update({status:"RETRYING",error:message,finishedAt:FieldValue.serverTimestamp(),durationMs:Date.now()-started});await runRef.update({runningSearches:FieldValue.increment(-1),queuedSearches:FieldValue.increment(1)});throw e;
 }finally{control.close();}
}

async function finishTask(runRef:DocumentReference,taskRef:DocumentReference,outcome:{status:string;calls:number;results:number;alerts:number;warnings:string[]},started:number){
 let final=false;await db.runTransaction(async tx=>{const runSnap=await tx.get(runRef),taskSnap=await tx.get(taskRef);if(["OK","WARNING","CANCELLED","ERROR"].includes(taskSnap.data()?.status))return;const r=runSnap.data()!,previous=taskSnap.data()?.status,completed=Number(r.completedSearches||0)+1,total=Number(r.searches||0),failed=Number(r.failedSearches||0)+(outcome.status==="ERROR"?1:0),warning=Number(r.warningSearches||0)+(outcome.status==="WARNING"?1:0);final=completed>=total;tx.update(taskRef,{...outcome,finishedAt:FieldValue.serverTimestamp(),durationMs:Date.now()-started});tx.update(runRef,{completedSearches:completed,...(["QUEUED","RETRYING"].includes(previous)?{queuedSearches:Math.max(0,Number(r.queuedSearches||0)-1)}:{runningSearches:Math.max(0,Number(r.runningSearches||0)-1)}),results:FieldValue.increment(outcome.results),alerts:FieldValue.increment(outcome.alerts),warningSearches:warning,failedSearches:failed,...(final?{status:r.cancelRequestedAt?"CANCELLED":failed>0?"ERROR":warning>0?"WARNING":"OK",finishedAt:FieldValue.serverTimestamp(),durationMs:Date.now()-r.startedAt.toMillis()}:{})});});
 if(final){const run=(await runRef.get()).data()!,cfg={...defaults,...run.settings} as Settings;if(!run.cancelRequestedAt&&cfg.emailTo){const results=(await db.collection("flight_results").where("runId","==",runRef.id).get()).docs.map((d:any)=>d.data()).filter((x:any)=>x.alert);if(results.length)try{await sendEmail(cfg.emailTo,results,cfg.currency)}catch(e:any){await runRef.update({status:"WARNING",emailError:String(e.message)});await logEvent({runRef,searchId:""},"Invio email non riuscito",{error:String(e.message)});}}await logEvent({runRef,searchId:""},"Tutti i sotto-task sono terminati");}
}
function insideHorizon(date:string,months:number){const max=new Date();max.setMonth(max.getMonth()+months);return new Date(date)<=max;}
async function searchRoundTrips(s:Search,cfg:Settings,ctx:TraceContext){
 const dates=departureDates(s,cfg.monthsAhead);
 const [origins,destinations,returnOrigins,returnDestinations]=await Promise.all([airportCodes(s.origin),airportCodes(s.destination),airportCodes(s.returnOrigin||s.destination),airportCodes(s.returnDestination||s.origin)]);
 const queries=tripQueries(s,dates,origins,destinations,returnOrigins,returnDestinations);
 await logEvent(ctx,"Piano chiamate A/R",{dates,allowedDays:s.allowedDays,nights:s.nights,airportPairsPerDate:dates.length?queries.length/dates.length:0,...plannedRequests(queries),note:"Tentativi aggiuntivi solo per cambio chiave satura; arresto al termine del giro."});
 return collectRoundTrips(queries,s.travelers,cfg.topResults,q=>fetchTrip(q,s,cfg,ctx));
}
async function fetchTrip(trip:FlightQuery,s:Search,cfg:Settings,ctx:TraceContext):Promise<TripReply>{
 let calls=0;const warnings:string[]=[];
 const providers=[...(cfg.serpApiEnabled?[{name:"SerpApi",keys:SERPAPI_KEYS.value()}]:[]),...(cfg.rapidApiEnabled?[{name:"RapidAPI",keys:RAPIDAPI_KEYS.value()}]:[])];
 const allCandidates=keyCandidates(providers);
 const stateRef=ctx.runRef.collection("state").doc("api_keys"),globalRef=db.doc("engine_state/api_keys");
 const attempted=new Set<string>();
 while(true){
  const selection=await db.runTransaction(async tx=>{
   const snap=await tx.get(stateRef);let state=snap.data() as KeyState|undefined;
   if(!state){
    const prior=(await tx.get(globalRef)).data();
    const previous:KeyState={cycle:Number(prior?.cycle||0),exhausted:prior?.exhausted||[]};
    state=beginKeyRun(previous,allCandidates);tx.set(stateRef,state);
    tx.set(globalRef,{...previous,cycle:state.cycle});
   }
   const available=selectKey(state,allCandidates,new Set()).key;
   return{...selectKey(state,allCandidates,attempted),exhausted:!available};
  });
  const selected=selection.key;
  if(!selected){
   const message="Tutte le chiavi sono sature o assenti: esecuzione delle chiamate terminata, nessun nuovo giro.";
   warnings.push(message);await logEvent(ctx,message,{cycle:selection.state.cycle});
   return{calls,warnings,options:[],exhausted:selection.exhausted};
  }
  attempted.add(selected.id);
  const request=tripRequest(selected.provider,selected.key,trip,s.travelers,s.maxStops,cfg.currency);
  await logEvent(ctx,"Chiave selezionata",{provider:selected.provider,keyIndex:selected.index,cycle:selection.state.cycle,leg:trip.leg,departureDate:trip.departureDate,returnDate:trip.returnDate||null});
  calls++;
  const result=await loggedRequest(request.url,request.init,request.kind,{...ctx,leg:trip.leg,keyIndex:selected.index,keyCycle:selection.state.cycle,maxStops:s.maxStops},selected.key);
  if(result.status==="LIMIT"){
   await db.runTransaction(async tx=>{
    const [local,global]=await Promise.all([tx.get(stateRef),tx.get(globalRef)]);
    tx.update(stateRef,{exhausted:[...new Set([...(local.data()?.exhausted||[]),selected.id])]});
    tx.set(globalRef,{cycle:Number(global.data()?.cycle||0),exhausted:[...new Set([...(global.data()?.exhausted||[]),selected.id])]});
   });
   warnings.push(selected.provider+" chiave "+selected.index+": "+result.message);
   await logEvent(ctx,"Quota esaurita: chiave esclusa per tutta l'esecuzione",{provider:selected.provider,keyIndex:selected.index,cycle:selection.state.cycle});continue;
  }
  if(result.status==="ERROR")warnings.push(selected.provider+" "+trip.origin+"-"+trip.destination+" "+trip.departureDate+": "+result.message);
  return{calls,warnings,provider:selected.provider,options:result.status==="OK"?result.options:[]};
 }
}
const CITY_AIRPORTS:Record<string,string[]>={"TENERIFE":["TFS","TFN"],"MILANO":["MXP","LIN","BGY"],"MILANO/BERGAMO":["MXP","LIN","BGY"],"ROMA":["FCO","CIA"],"LONDRA":["LHR","LGW","STN","LTN","LCY"],"PARIGI":["CDG","ORY","BVA"],"BRUXELLES":["BRU","CRL"],"ISTANBUL":["IST","SAW"],"TOKYO":["NRT","HND"],"NEW YORK":["JFK","EWR"],"BARCELLONA":["BCN"],"MADRID":["MAD"],"SIVIGLIA":["SVQ"],"LISBONA":["LIS"],"PORTO":["OPO"],"ATENE":["ATH"],"MYKONOS":["JMK"],"SANTORINI":["JTR"],"PAROS":["PAS"],"MILOS":["MLO"],"HERAKLION":["HER"],"CHANIA":["CHQ"],"NAXOS":["JNX"],"KOS":["KGS"],"BODRUM":["BJV"],"BUCAREST":["OTP"],"TALLINN":["TLL"],"BERGEN":["BGO"],"OSLO":["OSL"],"BANGKOK":["BKK"],"PHUKET":["HKT"],"OKINAWA":["OKA"],"OSAKA":["KIX"],"PECHINO":["PEK"],"SHANGHAI":["PVG"],"DUBAI":["DXB"],"DOHA":["DOH"],"SINGAPORE":["SIN"]};
Object.assign(CITY_AIRPORTS,{"NAPOLI":["NAP"],"VENEZIA":["VCE"],"BOLOGNA":["BLQ"],"TORINO":["TRN"],"PISA":["PSA"],"FIRENZE":["FLR"],"BARI":["BRI"],"PALERMO":["PMO"],"CATANIA":["CTA"],"CAGLIARI":["CAG"],"VALENCIA":["VLC"],"MALAGA":["AGP"],"AMSTERDAM":["AMS"],"FRANCOFORTE":["FRA"],"MONACO":["MUC"],"BERLINO":["BER"],"VIENNA":["VIE"],"ZURIGO":["ZRH"],"COPENAGHEN":["CPH"],"STOCCOLMA":["ARN"],"HELSINKI":["HEL"],"PRAGA":["PRG"],"BUDAPEST":["BUD"],"VARSAVIA":["WAW"],"CRACOVIA":["KRK"],"LOS ANGELES":["LAX"],"SAN FRANCISCO":["SFO"],"MIAMI":["MIA"],"HONG KONG":["HKG"],"SYDNEY":["SYD"]});
async function airportCodes(value:string){
 const codes:string[]=[];
 for(const token of String(value||"").split(",")){
  const v=token.trim().toUpperCase();if(!v)continue;
  if(CITY_AIRPORTS[v])codes.push(...CITY_AIRPORTS[v]);
  else if(/^[A-Z]{3}$/.test(v))codes.push(v);
  else{const catalog=await getAirportCatalog();const found=resolveCatalogAirport(catalog.airports,v);if(!found.length)throw new HttpsError("invalid-argument",`Aeroporto o città non riconosciuti: ${v}. Seleziona un suggerimento o inserisci il codice IATA.`);codes.push(...found);}
 }
 return [...new Set(codes)];
}
async function latestPrice(id:string){const x=await db.collection("flight_results").where("searchId","==",id).orderBy("checkedAt","desc").limit(1).get();return x.empty?null:Number(x.docs[0].data().pricePerPerson);}
function isDrop(old:number|null,current:number,pct:number){return old!==null&&current<=old*(1-pct/100);}
async function sendEmail(to:string,offers:any[],currency:string){
 const tr=nodemailer.createTransport({service:"gmail",auth:{user:EMAIL_USER.value(),pass:EMAIL_APP_PASSWORD.value()}});
 await tr.sendMail({from:EMAIL_USER.value(),to,subject:"Flight Engine: nuove occasioni",html:renderAlertEmail(offers,currency)});
}
