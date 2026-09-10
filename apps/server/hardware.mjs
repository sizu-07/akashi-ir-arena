import {readFileSync} from 'node:fs';
export const hardware=JSON.parse(readFileSync(new URL('../../specs/hardware-profile.json',import.meta.url),'utf8'));
export const receiverIds=hardware.receivers.map(r=>r.id);
export function deviceReady(p){return p.hardwareProfile===hardware.profile&&p.hardwareReady===true&&!p.bench&&!p.lowBattery;}
