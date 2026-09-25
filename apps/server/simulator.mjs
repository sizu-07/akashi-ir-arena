import mqtt from 'mqtt';
import {hardware,receiverIds} from './hardware.mjs';
import {randomUUID} from 'node:crypto';
export async function simulate(devices,port){const guns=[],activeIntervals=new Set();
 for(const d of devices){const client=mqtt.connect(`mqtt://127.0.0.1:${port}`,{clientId:d.id,username:d.id,password:d.key,reconnectPeriod:1000});const g={...d,client,boot:randomUUID(),seq:0,shot:0,state:null,rxFrames:{rx1:0,rx2:0,rx3:0}};guns.push(g);
  const pub=(suffix,m)=>client.publish(`irgame/v1/device/${d.id}/${suffix}`,JSON.stringify(m),{qos:suffix==='telemetry'?0:1});g.pub=pub;
  g.event=(type,payload)=>{if(!g.state)return;pub('event',{schema_version:1,device_id:d.id,boot_id:g.boot,message_id:`${g.boot}-${++g.seq}`,seq:g.seq,game_id:g.state.game_id,game_generation:g.state.game_generation,server_time_ms:Date.now(),type,payload});};
  client.on('connect',()=>{client.subscribe([`irgame/v1/device/${d.id}/desired`,`irgame/v1/device/${d.id}/command`],{qos:1});pub('hello',{boot_id:g.boot});});
  client.on('message',(topic,raw)=>{const s=JSON.parse(raw);if(topic.endsWith('/desired')){g.state=s;if(s.phase==='COUNTDOWN'&&g.lastCommand!==s.command_id){g.lastCommand=s.command_id;g.event('command_ack',{command_id:s.command_id,result:'ok'});}}});
  g.timer=setInterval(()=>pub('telemetry',{boot_id:g.boot,device_time_ms:Date.now(),syncRtt:2,rssi:-40,battery:3.9,hardware_profile:hardware.profile,hardware_ready:true,firmware_version:'0.7.0-sim',bench:false,motor_active:false,rx_frames:g.rxFrames}),500);
 }
 const pair=(shooter,victim)=>{const a=guns.find(g=>g.id===shooter),b=guns.find(g=>g.id===victim);if(!a||!b)throw Error('端末を選択してください');return {a,b};};
 return {hit(shooter,victim,receiver='rx1'){if(![...receiverIds,'all'].includes(receiver))throw Error('受信機を選択してください');const {a,b}=pair(shooter,victim);const shot_seq=a.shot++%256;a.event('shot_fired',{shot_seq,weapon_id:1});setTimeout(()=>{for(const receiver_id of receiver==='all'?receiverIds:[receiver]){b.rxFrames[receiver_id]++;b.event('hit_candidate',{shooter_id:a.shooterId,shot_seq,weapon_id:1,flags:0,receiver_id});}},35);},
  revive(shooter,victim){const {a,b}=pair(shooter,victim);if(a.team!==b.team)throw Error('復活は味方同士のみです');if(b.state?.hp!==0)throw Error('復活対象はHP 0の味方です');const shot_seq=a.shot++%256;a.event('shot_fired',{shot_seq,weapon_id:1});let count=0;
    const timer=setInterval(()=>{a.event('shot_hold',{shot_seq});b.rxFrames.rx1++;b.event('hit_candidate',{shooter_id:a.shooterId,shot_seq,weapon_id:1,flags:1,receiver_id:'rx1'});if(++count>=22){clearInterval(timer);activeIntervals.delete(timer);a.event('shot_released',{shot_seq});}},150);activeIntervals.add(timer);},
  async close(){for(const timer of activeIntervals)clearInterval(timer);await Promise.all(guns.map(g=>{clearInterval(g.timer);return new Promise(r=>g.client.end(true,r));}));}};
}
