import {mkdirSync,existsSync,readFileSync,appendFileSync,writeFileSync,renameSync} from 'node:fs';
import path from 'node:path';
export function storage(dir){mkdirSync(dir,{recursive:true});const snapshot=path.join(dir,'snapshot.json'),events=path.join(dir,'events.jsonl');
  return {load(){if(!existsSync(snapshot))return null;return JSON.parse(readFileSync(snapshot,'utf8'));},
    log(e){appendFileSync(events,JSON.stringify(e)+'\n');},save(s){writeFileSync(snapshot+'.tmp',JSON.stringify(s));renameSync(snapshot+'.tmp',snapshot);},
    csv(){const rows=existsSync(events)?readFileSync(events,'utf8').trim().split('\n').filter(Boolean).map(s=>JSON.parse(s)):[];
      const cell=v=>'"'+String(v??'').replace(/^[=+@-]/,"'$&").replaceAll('"','""')+'"';return '\uFEFF'+['at,type,gameId,details',...rows.map(r=>[new Date(r.at).toISOString(),r.type,r.gameId,JSON.stringify(r)].map(cell).join(','))].join('\r\n');}};
}
