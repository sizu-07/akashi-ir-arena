import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const read=name=>JSON.parse(readFileSync(path.join(root,name),'utf8').replace(/^\uFEFF/,''));
const base=read('config/provision/gun-001.json'),local=read('config/local.json');
if(typeof base.ssid!=='string'||!base.ssid||typeof base.password!=='string'||base.password.length<8||!base.host)
  throw Error('gun-001の保存済みWi-Fi設定が必要です');
const dest=path.join(root,'config/provision/players-4e');mkdirSync(dest,{recursive:true});
for(let player=1;player<=4;player++){
  const id=`gun-00${player}`,device=local.devices.find(d=>d.id===id);
  if(!device?.key||device.shooterId!==player)throw Error(`${id}の本番登録・銃IDを確認してください`);
  const settings={ssid:base.ssid,password:base.password,host:base.host,port:base.port??1883,id,key:device.key,
    hardwareProfile:'xiao-s3-plus-3rx-6led-motor-trigger',bench:false,adcScale:11};
  if(base.staticIp){
    const parts=base.staticIp.split('.').map(Number);
    if(parts.length!==4||parts.some(n=>!Number.isInteger(n)||n<0||n>255)||parts[3]<1||parts[3]+3>254||!base.gateway||!base.subnet)
      throw Error('4台分の固定IPを作成できません。gun-001のstaticIp/gateway/subnetを確認してください');
    parts[3]+=player-1;settings.staticIp=parts.join('.');settings.gateway=base.gateway;settings.subnet=base.subnet;
  }
  writeFileSync(path.join(dest,`${id}.json`),JSON.stringify(settings,null,2)+'\n');
  console.log(`${id}: player${player}, team=${device.team}, IP=${settings.staticIp??'DHCP'} (credentials not printed)`);
}
console.log('Saved config/provision/players-4e/; existing diagnostic settings were preserved.');
