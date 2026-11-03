import {useEffect,useState} from "react";
import {httpsCallable} from "firebase/functions";
import {collection,onSnapshot,orderBy,query} from "firebase/firestore";
import {db,functions} from "./firebase";

export function RunControl({run}:{run:any}){
 const [now,setNow]=useState(Date.now()),[busy,setBusy]=useState(false),[error,setError]=useState(""),[tasks,setTasks]=useState<any[]>([]),[open,setOpen]=useState(false);
 useEffect(()=>{const timer=setInterval(()=>setNow(Date.now()),15000);return()=>clearInterval(timer);},[]);
 useEffect(()=>{if(run.controlVersion!==2)return;return onSnapshot(query(collection(db,"execution_logs",run.id,"tasks"),orderBy("createdAt")),snap=>setTasks(snap.docs.map(d=>({id:d.id,...d.data()}))),e=>setError(e.message));},[run.id,run.controlVersion]);
 const heartbeat=run.heartbeatAt?.toMillis?.(),stale=!!heartbeat&&now-heartbeat>5*60000;
 const stop=async()=>{setBusy(true);setError("");try{await httpsCallable(functions,"stopFlightSearch")({runId:run.id,archive:stale&&!!run.cancelRequestedAt});}catch(e:any){setError(e.message);}finally{setBusy(false);}};
 const date=(value:any)=>value?.toDate?.().toLocaleString("it-IT")||"non disponibile";
 return <section className="run-control">
 {run.lastEvent&&<p>Ultima attività: {run.lastEvent} · {date(run.lastActivityAt)}</p>}
 {run.controlVersion===2&&<div className="task-progress"><p><b>Avanzamento:</b> {run.completedSearches||0}/{run.searches||0} concluse · {run.runningSearches||0} in corso · {run.queuedSearches||0} in attesa · {run.failedSearches||0} errori</p><button className="secondary" onClick={()=>setOpen(!open)}>{open?"Nascondi sotto-task":"Mostra sotto-task"}</button>{open&&<div className="task-list">{tasks.map(task=><div key={task.id}><span className={`badge ${String(task.status).toLowerCase()}`}>{task.status}</span><span>{task.search?.destinationName||task.searchId}</span><small>{task.calls||0} chiamate · {task.results||0} risultati{task.attempts>1?` · tentativo ${task.attempts}`:""}</small>{task.error&&<small>{task.error}</small>}</div>)}</div>}</div>}
 {["RUNNING","QUEUED"].includes(run.status)&&<>
 <p>{[1,2].includes(run.controlVersion)?`Ultimo segnale dal processo: ${date(run.heartbeatAt)}`:"Esecuzione precedente ai controlli di arresto: attività del processo non verificabile."}</p>
 {stale&&<p role="status">Nessun segnale da oltre 5 minuti. Il processo potrebbe essere interrotto o non raggiungibile.</p>}
 {run.cancelRequestedAt&&<p>Arresto richiesto. In attesa della conferma del processo.</p>}
 <button className="secondary" disabled={busy||(!!run.cancelRequestedAt&&!stale)} onClick={stop}>{busy?"Invio…":![1,2].includes(run.controlVersion)||stale&&run.cancelRequestedAt?"Archivia come interrotta":"Arresta esecuzione"}</button>
 {(![1,2].includes(run.controlVersion)||stale&&run.cancelRequestedAt)&&<p>L’archiviazione chiude la voce nello storico; non conferma la terminazione del processo remoto.</p>}
 </>}
 {error&&<p role="alert">{error}</p>}
 </section>;
}
