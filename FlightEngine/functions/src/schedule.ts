type ScheduleSettings={scheduleEnabled:boolean;scheduleTimezone:string;scheduleHour:number;scheduleMinute:number;scheduleDays:string[]};

// Use the scheduled event time, not the wall clock after a delayed/cold start.
export function scheduledSlot(cfg:ScheduleSettings,scheduleTime:string){
 if(!cfg.scheduleEnabled)return null;
 const timeZone=cfg.scheduleTimezone||"Europe/Rome";
 const parts=new Intl.DateTimeFormat("en-CA",{timeZone,year:"numeric",month:"2-digit",day:"2-digit",weekday:"short",hour:"2-digit",minute:"2-digit",hourCycle:"h23"}).formatToParts(new Date(scheduleTime));
 const part=(type:string)=>parts.find(x=>x.type===type)?.value||"";
 const dayMap:Record<string,string>={Mon:"MON",Tue:"TUE",Wed:"WED",Thu:"THU",Fri:"FRI",Sat:"SAT",Sun:"SUN"};
 const day=dayMap[part("weekday")],hour=Number(part("hour")),minute=Number(part("minute"));
 if(!cfg.scheduleDays.includes(day)||hour!==Number(cfg.scheduleHour)||minute!==Number(cfg.scheduleMinute))return null;
 return `${part("year")}-${part("month")}-${part("day")} ${String(hour).padStart(2,"0")}:${String(minute).padStart(2,"0")} ${timeZone}`;
}
