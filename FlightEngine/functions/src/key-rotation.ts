import {createHash} from "node:crypto";
export type KeyCandidate={id:string;provider:string;key:string;index:number};
export type KeyState={cycle:number;exhausted:string[];startKeyId?:string};
export function keyCandidates(providers:{name:string;keys:string[]}[]):KeyCandidate[]{
 const seen=new Set<string>();
 return providers.flatMap(p=>p.keys.flatMap((value,index)=>{
  const key=value.trim();if(!key)return[];
  const id=createHash("sha256").update(`${p.name}:${key}`).digest("hex");
  if(seen.has(id))return[];seen.add(id);return[{id,provider:p.name,key,index:index+1}];
 }));
}
export function selectKey(state:KeyState,candidates:KeyCandidate[],attempted:Set<string>){
 const start=Math.max(0,candidates.findIndex(k=>k.id===state.startKeyId));
 const ordered=[...candidates.slice(start),...candidates.slice(0,start)];
 const key=ordered.find(k=>!state.exhausted.includes(k.id)&&!attempted.has(k.id));
 return{state,key,reset:false};
}
// Called once per execution, transactionally shared by all its tasks and retries.
// Resume at the first previously usable key and permit only one full turn.
export function beginKeyRun(previous:KeyState,candidates:KeyCandidate[]):KeyState{
 const first=selectKey(previous,candidates,new Set()).key||candidates[0];
 return{cycle:previous.cycle+1,exhausted:[],...(first?{startKeyId:first.id}:{})};
}
