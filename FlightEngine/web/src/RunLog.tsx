import {useEffect,useState} from "react";
import {collection,doc,getDoc,getDocs,onSnapshot,orderBy,query} from "firebase/firestore";
import {db} from "./firebase";

type Entry={id:string;kind:string;startedAt?:any;status?:string;provider?:string;leg?:string;searchId?:string;message?:string;httpStatus?:number;durationMs?:number;bodyChunks?:number;[key:string]:any};
async function readBody(runId:string,id:string){
 const snap=await getDocs(query(collection(db,"execution_logs",runId,"entries",id,"body"),orderBy("index")));
 return snap.docs.map(d=>d.data().text).join("");
}
function ResponseBody({runId,entry}:{runId:string;entry:Entry}){
 const [text,setText]=useState<string|null>(null),[error,setError]=useState(""),[busy,setBusy]=useState(false);
 const load=async()=>{setBusy(true);setError("");try{const body=await readBody(runId,entry.id);try{setText(JSON.stringify(JSON.parse(body),null,2))}catch{setText(body||"Risposta vuota.")}}catch(e:any){setError(e.message)}finally{setBusy(false)}};
 return <div><button className="secondary" disabled={busy} onClick={load}>{busy?"Caricamento…":text===null?"Mostra risposta completa":"Ricarica risposta"}</button>{error&&<p role="alert">{error}</p>}{text!==null&&<pre>{text}</pre>}</div>;
}
export function RunLog({runId,version}:{runId:string;version?:number}){
 const [open,setOpen]=useState(false),[entries,setEntries]=useState<Entry[]>([]),[error,setError]=useState(""),[loading,setLoading]=useState(false),[exporting,setExporting]=useState(false);
 useEffect(()=>{if(!open)return;setLoading(true);setError("");return onSnapshot(query(collection(db,"execution_logs",runId,"entries"),orderBy("startedAt")),snap=>{setEntries(snap.docs.map(d=>({id:d.id,...d.data()} as Entry)));setLoading(false)},e=>{setError(e.message);setLoading(false)})},[open,runId]);
 const download=async()=>{setExporting(true);setError("");try{
  const run=await getDoc(doc(db,"execution_logs",runId));
  const snap=await getDocs(query(collection(db,"execution_logs",runId,"entries"),orderBy("startedAt")));
  const taskSnap=await getDocs(query(collection(db,"execution_logs",runId,"tasks"),orderBy("createdAt")));
  const full=[];for(const d of snap.docs){const entry={id:d.id,...d.data()} as Entry;full.push({...entry,startedAt:entry.startedAt?.toDate?.().toISOString()||null,...(entry.kind==="CALL"?{responseBody:await readBody(runId,d.id)}:{})})}
  const tasks=taskSnap.docs.map(d=>{const value:any={id:d.id,...d.data()};for(const key of ["createdAt","startedAt","finishedAt"])if(value[key]?.toDate)value[key]=value[key].toDate().toISOString();return value;});
  const url=URL.createObjectURL(new Blob([JSON.stringify({runId,run:run.data(),exportedAt:new Date().toISOString(),tasks,entries:full},null,2)],{type:"application/json"}));
  const a=document.createElement("a");a.href=url;a.download=`flight-engine-log-${runId}.json`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
 }catch(e:any){setError(e.message)}finally{setExporting(false)}};
 return <section className="run-log"><button className="secondary" onClick={()=>setOpen(!open)}>{open?"Nascondi log":"Mostra log"}</button>{open&&<div>
 <p>Parametri, risposte ed errori delle singole chiamate. Le chiavi API sono oscurate.</p>
 <button className="secondary" disabled={exporting||loading} onClick={download}>{exporting?"Esportazione…":"Scarica log completo"}</button>
 {error&&<p role="alert">Impossibile leggere il log: {error}</p>}{loading&&<p>Caricamento log…</p>}
 {!loading&&!entries.length&&<p>{version?"Nessuna chiamata o evento registrato finora. Controlla anche l’esito e gli avvisi dell’esecuzione.":"Questa esecuzione proviene da un backend senza log dettagliato. Pubblica le Functions aggiornate, poi avvia una nuova ricerca. Aggiornare soltanto il sito non basta."}</p>}
 {entries.map((entry,i)=><details key={entry.id} className="log-entry"><summary>{i+1}. {entry.startedAt?.toDate?.().toLocaleTimeString("it-IT")||"…"} · {entry.kind==="CALL"?`${entry.provider}${entry.keyIndex?` chiave ${entry.keyIndex}`:""} · ${entry.leg} · ${entry.status}${entry.httpStatus?` · HTTP ${entry.httpStatus}`:""}`:entry.message}{entry.durationMs!=null?` · ${entry.durationMs} ms`:""}</summary>
 <pre>{JSON.stringify({...entry,startedAt:entry.startedAt?.toDate?.().toISOString()||null},null,2)}</pre>
 {entry.kind==="CALL"&&(entry.bodyLogged===false?<p>Corpo della risposta non registrato (LOG_RESPONSE_BODIES=false nello script).</p>:<ResponseBody runId={runId} entry={entry}/>)}</details>)}
 </div>}</section>;
}
