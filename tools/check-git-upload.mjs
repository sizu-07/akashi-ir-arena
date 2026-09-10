// Scan only Git upload candidates; never print credential values or matching lines.
import {execFileSync} from 'node:child_process';import {readFileSync,statSync,readdirSync} from 'node:fs';
const files=execFileSync('git',['-c',`safe.directory=${process.cwd().replaceAll('\\','/')}`,'ls-files','--cached','--others','--exclude-standard','-z'],{encoding:'utf8'}).split('\0').filter(Boolean),unique=[...new Set(files)];
const secrets=[];
function collect(v){if(!v||typeof v!=='object')return;for(const[k,x]of Object.entries(v)){if(typeof x==='string'&&/^(operatorPin|key|password|ssid)$/i.test(k)&&x.length>=8)secrets.push(x);else if(typeof x==='object')collect(x);}}
try{for(const f of readdirSync('config',{recursive:true}))if(f.endsWith('.json'))collect(JSON.parse(readFileSync('config/'+f,'utf8')));}catch(e){if(e.code!=='ENOENT')throw e;}
const findings=[];let bytes=0;const patterns=[/gh[pousr]_[A-Za-z0-9]{30,}/,/github_pat_[A-Za-z0-9_]{30,}/,/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/];
for(const f of unique){const size=statSync(f).size;bytes+=size;if(size>=100*1024*1024)findings.push({file:f,reason:'File reaches 100 MiB'});if(/^(?:config|data|logs|node_modules|\.tools|\.pnpm-store)\//.test(f))findings.push({file:f,reason:'Local-only directory included'});const b=readFileSync(f);if(secrets.some(s=>b.includes(Buffer.from(s))))findings.push({file:f,reason:'Matches a local credential value'});if(/\.(?:mjs|js|json|md|txt|ps1|ya?ml|ini|cpp|h|csv)$/.test(f)&&patterns.some(p=>p.test(b.toString('utf8'))))findings.push({file:f,reason:'Possible credential signature'});}
console.log(JSON.stringify({files:unique.length,totalMiB:Math.round(bytes/1048576*10)/10,findings,note:'Heuristic scan; credentials themselves are never displayed.'},null,2));if(findings.length)process.exit(1);
