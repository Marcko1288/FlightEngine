import {useEffect,useId,useMemo,useState} from "react";
import {httpsCallable} from "firebase/functions";
import {functions} from "./firebase";
import {airports,cityGroups} from "./airports";
import type {AirportChoice} from "../../functions/src/airport-catalog";
const normalize=(text:string)=>text.normalize("NFD").replace(/[\u0300-\u036f]/g,"").toLowerCase().trim();
type Reply={choices:AirportChoice[];stale:boolean};
const cache=new Map<string,{data:Reply;expires:number}>();
const requests=new Map<string,Promise<Reply>>();
async function lookup(query:string):Promise<Reply>{
 const found=cache.get(query);if(found&&found.expires>Date.now())return found.data;
 const active=requests.get(query);if(active)return active;
 const request=httpsCallable<{query:string},Reply>(functions,"searchAirportCatalog",{timeout:30000})({query}).then(r=>{
  if(cache.size>=100)cache.delete(cache.keys().next().value!);
  cache.set(query,{data:r.data,expires:Date.now()+60*60*1000});return r.data;
 }).finally(()=>requests.delete(query));requests.set(query,request);return request;
}
export function AirportInput(p:{label:string;value:string;onChange:(x:string)=>void;required?:boolean}){
 const [open,setOpen]=useState(false),[remote,setRemote]=useState<AirportChoice[]>([]),[loading,setLoading]=useState(false),[message,setMessage]=useState(""),[selected,setSelected]=useState(-1);
 const listId=useId(),q=normalize(p.value);
 const local=useMemo<AirportChoice[]>(()=>[
  ...cityGroups.map(g=>({key:`city-${g.city}`,value:g.codes,title:g.city.toUpperCase(),detail:`Tutti gli aeroporti (${g.codes})`,kind:"city" as const})),
  ...airports.map(a=>({key:`airport-${a.code}`,value:a.code,title:a.code,detail:`${a.city} — ${a.name} (${a.country})`,kind:"airport" as const}))
 ].filter(x=>!q||normalize(`${x.title} ${x.detail} ${x.value}`).includes(q)).slice(0,12),[q]);
 useEffect(()=>{setRemote([]);setMessage("");setSelected(-1);setLoading(false);if(!open||q.length<2||q.includes(","))return;let cancelled=false;
  setLoading(true);const timer=setTimeout(()=>{lookup(q).then(data=>{if(!cancelled){setRemote(data.choices);setMessage(data.stale?"Catalogo temporaneamente non aggiornato.":"")}}).catch(()=>{if(!cancelled)setMessage("Catalogo globale non disponibile: mostro i suggerimenti locali. Puoi inserire il codice IATA.")}).finally(()=>{if(!cancelled)setLoading(false)})},300);
  return()=>{cancelled=true;clearTimeout(timer)};
 },[q,open]);
 const choices=useMemo(()=>{const seen=new Set<string>();return[...local,...remote].filter(x=>{const key=`${x.kind}:${x.value.split(",").sort().join(",")}`;if(seen.has(key))return false;seen.add(key);return true;}).slice(0,24)},[local,remote]);
 const choose=(choice:AirportChoice)=>{p.onChange(choice.value);setOpen(false);setSelected(-1)};
 return <label className="airport-field">{p.label}<input required={p.required!==false} autoComplete="off" role="combobox" aria-autocomplete="list" aria-expanded={open} aria-controls={listId} aria-activedescendant={selected>=0?`${listId}-${selected}`:undefined} placeholder="Città, aeroporto o codice IATA" value={p.value} onFocus={()=>setOpen(true)} onBlur={()=>setOpen(false)} onChange={e=>{p.onChange(e.target.value.toUpperCase());setOpen(true)}} onKeyDown={e=>{
  if(e.key==="Escape"){setOpen(false);return;}
  if(e.key==="ArrowDown"||e.key==="ArrowUp"){e.preventDefault();setOpen(true);setSelected(i=>choices.length?(i+(e.key==="ArrowDown"?1:-1)+choices.length)%choices.length:-1)}
  if(e.key==="Enter"&&open&&selected>=0&&choices[selected]){e.preventDefault();choose(choices[selected])}
 }}/>{open&&<div className="airport-menu"><div id={listId} role="listbox">{choices.map((x,i)=><button type="button" role="option" aria-selected={selected===i} id={`${listId}-${i}`} className={`airport-option ${x.kind}${selected===i?" selected":""}`} key={x.key} onMouseDown={e=>e.preventDefault()} onClick={()=>choose(x)}><b>{x.title}</b><span>{x.detail}</span></button>)}</div>{loading&&<div className="airport-empty" role="status">Ricerca nel catalogo mondiale…</div>}{message&&<div className="airport-empty" role="status">{message}</div>}{!choices.length&&!loading&&!message&&<div className="airport-empty">Nessuna corrispondenza. Prova il nome internazionale o il codice IATA.</div>}</div>}<small className="hint">Città: tutti gli aeroporti del gruppo. Codice IATA: un aeroporto. Catalogo globale OurAirports.</small></label>;
}
