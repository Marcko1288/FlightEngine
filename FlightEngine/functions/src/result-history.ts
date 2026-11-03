type HistoryResult={searchId:string;runId?:string;pricePerPerson:number;checkedAt:any};
export function resultTime(r:HistoryResult){return r.checkedAt?.toMillis?.()||0;}
export function latestPerSearch<T extends HistoryResult>(results:T[]):T[]{
 const latest=new Map<string,T>();
 for(const r of results){
  const old=latest.get(r.searchId);
  if(!old||((r.runId&&r.runId===old.runId)?r.pricePerPerson<old.pricePerPerson:resultTime(r)>resultTime(old)||(resultTime(r)===resultTime(old)&&r.pricePerPerson<old.pricePerPerson)))latest.set(r.searchId,r);
 }
 return[...latest.values()].sort((a,b)=>resultTime(b)-resultTime(a));
}
