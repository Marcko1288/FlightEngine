"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.scheduledSlot = scheduledSlot;
// Use the scheduled event time, not the wall clock after a delayed/cold start.
function scheduledSlot(cfg, scheduleTime) {
    if (!cfg.scheduleEnabled)
        return null;
    const timeZone = cfg.scheduleTimezone || "Europe/Rome";
    const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(scheduleTime));
    const part = (type) => parts.find(x => x.type === type)?.value || "";
    const dayMap = { Mon: "MON", Tue: "TUE", Wed: "WED", Thu: "THU", Fri: "FRI", Sat: "SAT", Sun: "SUN" };
    const day = dayMap[part("weekday")], hour = Number(part("hour")), minute = Number(part("minute"));
    if (!cfg.scheduleDays.includes(day) || hour !== Number(cfg.scheduleHour) || minute !== Number(cfg.scheduleMinute))
        return null;
    return `${part("year")}-${part("month")}-${part("day")} ${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")} ${timeZone}`;
}
