import {EventEmitter} from 'node:events';
import type {ServerResponse} from 'node:http';
import {expect,test,vi} from 'vitest';
import {SseEventWriter} from '../../src/server/http-server.js';
class Response extends EventEmitter {destroyed=false;writes:string[]=[];blocked=false;write(v:unknown){this.writes.push(String(v));return !this.blocked;}}
const hint=(sequence:number,deviceId='dev_001')=>({schemaVersion:1,type:'inventory',change:'device_health',sequence,deviceId,online:false,healthUpdatedAt:'2026-10-18T00:00:00Z'});
const decode=(r:Response)=>r.writes.map(v=>JSON.parse(v.slice(6)));
test('a burst of health updates preserves every device and contiguous sequence',async()=>{vi.useFakeTimers();try{const r=new Response(),w=new SseEventWriter(r as unknown as ServerResponse,()=>3,{inventoryCoalesceMs:75});w.write(hint(1));w.write(hint(2,'dev_002'));w.write(hint(3));await vi.advanceTimersByTimeAsync(75);expect(decode(r)).toEqual([hint(1),hint(2,'dev_002'),hint(3)]);w.close();}finally{vi.useRealTimers();}});
test('health following a structural marker flushes the marker first',async()=>{vi.useFakeTimers();try{const r=new Response(),w=new SseEventWriter(r as unknown as ServerResponse,()=>2,{inventoryCoalesceMs:75});w.write({schemaVersion:1,type:'inventory',sequence:1});w.write(hint(2));await vi.advanceTimersByTimeAsync(75);expect(decode(r)).toEqual([{schemaVersion:1,type:'inventory',sequence:1},hint(2)]);w.close();}finally{vi.useRealTimers();}});
test('normal backpressure retains every bounded health delta',()=>{const r=new Response();r.blocked=true;const w=new SseEventWriter(r as unknown as ServerResponse,()=>3,{inventoryCoalesceMs:75});w.write(hint(1));w.write(hint(2));w.write(hint(3));r.blocked=false;r.emit('drain');expect(decode(r)).toEqual([hint(1),hint(2),hint(3)]);w.close();});
