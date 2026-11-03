const {test}=require('node:test');
const assert=require('node:assert/strict');
const {scheduledSlot}=require('../lib/schedule');
const cfg={scheduleEnabled:true,scheduleTimezone:'Europe/Rome',scheduleHour:2,scheduleMinute:30,scheduleDays:['TUE','WED','THU','FRI']};

test('Thursday 17 September runs at 02:30 Rome using the event time even when processed later',()=>{
 assert.equal(scheduledSlot(cfg,'2026-09-17T00:30:00Z'),'2026-09-17 02:30 Europe/Rome');
});
test('the former offset interval never matched the configured minute',()=>{
 for(const minute of ['08','23','38','53'])assert.equal(scheduledSlot(cfg,`2026-09-17T00:${minute}:00Z`),null);
});
test('disabled schedules, excluded days and other quarters do not start',()=>{
 assert.equal(scheduledSlot({...cfg,scheduleEnabled:false},'2026-09-17T00:30:00Z'),null);
 assert.equal(scheduledSlot(cfg,'2026-09-19T00:30:00Z'),null);
 for(const minute of ['00','15','45'])assert.equal(scheduledSlot(cfg,`2026-09-17T00:${minute}:00Z`),null);
});
test('winter time and midnight use the local date and weekday',()=>{
 assert.equal(scheduledSlot(cfg,'2026-12-17T01:30:00Z'),'2026-12-17 02:30 Europe/Rome');
 assert.equal(scheduledSlot({...cfg,scheduleHour:0,scheduleMinute:0},'2026-09-16T22:00:00Z'),'2026-09-17 00:00 Europe/Rome');
});
test('repeated autumn hour produces the same slot for deduplication',()=>{
 const sunday={...cfg,scheduleDays:['SUN']};
 assert.equal(scheduledSlot(sunday,'2026-10-25T00:30:00Z'),scheduledSlot(sunday,'2026-10-25T01:30:00Z'));
});
