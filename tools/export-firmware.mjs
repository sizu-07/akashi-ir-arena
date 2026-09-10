import {mkdirSync,copyFileSync,readFileSync,writeFileSync} from 'node:fs';import {createHash} from 'node:crypto';
const dest='firmware/release/v0.6',build='firmware/.pio/build/xiao_s3_plus';mkdirSync(dest,{recursive:true});
const sha=p=>createHash('sha256').update(readFileSync(p)).digest('hex');
const files=['bootloader.bin','partitions.bin','firmware.bin'],hashes={};
for(const name of files){copyFileSync(build+'/'+name,dest+'/'+name);hashes[name]=sha(dest+'/'+name);}
copyFileSync('.tools/platformio/packages/framework-arduinoespressif32/tools/partitions/boot_app0.bin',dest+'/boot_app0.bin');
hashes['boot_app0.bin']=sha(dest+'/boot_app0.bin');
const boot=readFileSync(dest+'/bootloader.bin');if(boot[0]!==0xe9||boot.readUInt16LE(12)!==9||(boot[3]>>4)!==4)throw Error('Expected ESP32-S3 16MB image');
writeFileSync(dest+'/sha256.json',JSON.stringify(hashes,null,2));
const sources=['firmware/src/main.cpp','firmware/include/ir_protocol.h','firmware/include/feedback.h','firmware/include/hardware_profile.h','firmware/platformio.ini','specs/hardware-profile.json'];
writeFileSync(dest+'/manifest.json',JSON.stringify({revision:'0.6.0',hardwareProfile:'xiao-s3-plus-3rx-motor',chip:'esp32s3',flashMB:16,psramMB:8,environment:'xiao_s3_plus',platform:'espressif32@6.9.0',arduino:'2.0.17',builtAt:new Date().toISOString(),physicalTests:'NOT PERFORMED',offsets:{'bootloader.bin':'0x0','partitions.bin':'0x8000','boot_app0.bin':'0xe000','firmware.bin':'0x10000'},sourceHashes:Object.fromEntries(sources.map(p=>[p,sha(p)]))},null,2));
console.log('Exported '+dest);
