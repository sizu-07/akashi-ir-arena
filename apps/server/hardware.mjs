import {readFileSync} from 'node:fs';
export const hardware=JSON.parse(readFileSync(new URL('../../specs/hardware-profile.json',import.meta.url),'utf8'));
export const receiverIds=hardware.receivers.map(r=>r.id);
export const receiverOnlyProfile='xiao-s3-plus-rx44-only';
export function receiverOnlyGame(p){return p.hardwareProfile===receiverOnlyProfile&&p.firmwareVersion==='0.7.1-rx44';}
export function deviceReady(p){return (p.hardwareProfile===hardware.profile||receiverOnlyGame(p))&&p.hardwareReady===true&&!p.bench&&!p.lowBattery;}
export function legacyMotorDemo(p){return ['legacy-motor-demo-1','legacy-motor-demo-2','legacy-motor-demo-3','legacy-motor-demo-4','legacy-motor-demo-5','legacy-motor-demo-6'].includes(p.firmwareVersion)&&p.bench&&p.hardwareProfile===hardware.profile;}
