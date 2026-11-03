import {FieldValue, type DocumentReference} from "firebase-admin/firestore";
import {parseResponse} from "./provider-response";

export type TraceContext={runRef:DocumentReference;searchId:string;leg?:string;keyIndex?:number;keyCycle?:number;maxStops?:number;signal?:AbortSignal;checkpoint?:()=>Promise<void>};
export function redact(text:string,secrets:string[]=[]){
 for(const secret of secrets.filter(Boolean))for(const value of new Set([secret,encodeURIComponent(secret)]))text=text.split(value).join("[REDACTED]");
 return text.replace(/("(?:api[_-]?key|x-rapidapi-key|authorization|set-cookie|cookie)"\s*:\s*)"(?:\\.|[^"\\])*"/gi,'$1"[REDACTED]"')
  .replace(/((?:api[_-]?key|x-rapidapi-key|authorization|set-cookie|cookie)["']?\s*[:=]\s*["']?)([^"'\s&,}\r\n]+)/gi,"$1[REDACTED]");
}
export function bodyChunks(text:string){
 // Even four-byte UTF-8 characters keep each document well below 1 MiB.
 const chunks:string[]=[];let chunk="";
 for(const char of text){chunk+=char;if(chunk.length>=100000){chunks.push(chunk);chunk="";}}
 if(chunk)chunks.push(chunk);return chunks;
}
export async function logEvent(ctx:TraceContext,message:string,data:Record<string,unknown>={}){
 await ctx.checkpoint?.();
 await ctx.runRef.update({lastActivityAt:FieldValue.serverTimestamp(),lastEvent:message,currentSearchId:ctx.searchId});
 await ctx.runRef.collection("entries").add({kind:"EVENT",startedAt:FieldValue.serverTimestamp(),searchId:ctx.searchId,message,...data});
}
export async function loggedRequest(url:string,init:RequestInit,kind:"serp"|"rapid",ctx:TraceContext,key:string){
 await ctx.checkpoint?.();
 const ref=ctx.runRef.collection("entries").doc(),started=Date.now();
 const safe=(text:string)=>redact(text,[key]);
 await ref.set({kind:"CALL",startedAt:FieldValue.serverTimestamp(),searchId:ctx.searchId,leg:ctx.leg||"",provider:kind==="serp"?"SerpApi":"RapidAPI",status:"RUNNING",request:{method:init.method||"GET",url:safe(url),...(typeof init.body==="string"?{body:safe(init.body)}:{}),headers:JSON.parse(safe(JSON.stringify(Object.fromEntries(new Headers(init.headers)))) )}});
 await ctx.runRef.update({apiCalls:FieldValue.increment(1)});
 await ref.update({keyIndex:ctx.keyIndex??null,keyCycle:ctx.keyCycle??null});
 let res:Response,body:string;
 try{
  res=await fetch(url,{...init,signal:ctx.signal?AbortSignal.any([ctx.signal,AbortSignal.timeout(120000)]):AbortSignal.timeout(120000)});
  await ref.update({httpStatus:res.status,httpStatusText:res.statusText,responseHeaders:JSON.parse(safe(JSON.stringify(Object.fromEntries(res.headers))))});
  body=await res.clone().text();
 }catch(e:any){
  const message=safe([e?.name,e?.message,e?.cause?.code,e?.cause?.message].filter(Boolean).join(": "));
  await ref.update({status:"ERROR",message,finishedAt:FieldValue.serverTimestamp(),durationMs:Date.now()-started});
  ctx.signal?.throwIfAborted();
  return{status:"ERROR" as const,message};
 }
 const chunks=bodyChunks(safe(body));
 for(let i=0;i<chunks.length;i++)await ref.collection("body").doc(String(i).padStart(8,"0")).set({index:i,text:chunks[i]});
 const parsed=await parseResponse(res,kind,ctx.maxStops);
 await ref.update({status:parsed.status,message:parsed.status==="OK"?"Offerta trovata":parsed.message,price:parsed.status==="OK"?parsed.price:null,bodyChunks:chunks.length,finishedAt:FieldValue.serverTimestamp(),durationMs:Date.now()-started});
 await ctx.checkpoint?.();
 return parsed;
}
