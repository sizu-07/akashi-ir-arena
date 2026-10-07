import {mkdirSync,copyFileSync,readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const sha=file=>createHash('sha256').update(readFileSync(path.join(root,file))).digest('hex');
const sources=['firmware/src/main.cpp','firmware/include/ir_protocol.h','firmware/include/feedback.h',
  'firmware/include/legacy_4e_profile.h','firmware/include/player_identity.h','firmware/include/serial_rx_gate.h','firmware/platformio.ini'];
for(let player=1;player<=4;player++){
  const environment=`player${player}_game`,dest=`firmware/release/players-4e/player${player}`;
  const build=`firmware/.pio/build/${environment}`;mkdirSync(path.join(root,dest),{recursive:true});
  const files=['bootloader.bin','partitions.bin','firmware.bin'];
  for(const file of files)copyFileSync(path.join(root,build,file),path.join(root,dest,file));
  copyFileSync(path.join(root,'.tools/platformio/packages/framework-arduinoespressif32/tools/partitions/boot_app0.bin'),path.join(root,dest,'boot_app0.bin'));
  files.push('boot_app0.bin');
  const boot=readFileSync(path.join(root,dest,'bootloader.bin'));
  if(boot[0]!==0xe9||boot.readUInt16LE(12)!==9||(boot[3]>>4)!==4)throw Error('Expected ESP32-S3 16MB image');
  if(!readFileSync(path.join(root,dest,'firmware.bin')).includes(Buffer.from(`gun-00${player}`)))throw Error(`Missing player${player} identity`);
  const hashes=Object.fromEntries(files.map(file=>[file,sha(`${dest}/${file}`)]));
  writeFileSync(path.join(root,dest,'sha256.json'),JSON.stringify(hashes,null,2)+'\n');
  writeFileSync(path.join(root,dest,'manifest.json'),JSON.stringify({firmwareVersion:'0.7.2-4e42',player,deviceId:`gun-00${player}`,
    shooterId:player,defaultTeam:player<=2?'A':'B',environment,hardwareProfile:'xiao-s3-plus-3rx-6led-motor-trigger',
    physicalBoard:'assembled-4e-led42',chip:'esp32s3',flashMB:16,platform:'espressif32@6.9.0',arduino:'2.0.17',
    pins:{trigger:2,irTx:6,irRx:[44,7,8],motor:9,led:42,battery:1},ledPixels:8,
    builtAt:new Date().toISOString(),physicalTests:'4-player match NOT PERFORMED; build and protocol tests only',
    offsets:{'bootloader.bin':'0x0','partitions.bin':'0x8000','boot_app0.bin':'0xe000','firmware.bin':'0x10000'},
    sourceHashes:Object.fromEntries(sources.map(file=>[file,sha(file)]))},null,2)+'\n');
  console.log(`Exported player${player}: ${dest}`);
}
