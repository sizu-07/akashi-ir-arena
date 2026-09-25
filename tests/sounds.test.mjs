import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {availableEffects} from '../apps/server/sounds.mjs';
import {createApp} from '../apps/server/main.mjs';

test('named effects appear without restarting and only exact filenames are served',async()=>{
  const dir=mkdtempSync(path.join(os.tmpdir(),'arena-effects-'));
  const effectsDir=path.join(dir,'effects');mkdirSync(effectsDir);
  let app;
  try {
    assert.deepEqual(availableEffects(effectsDir),{});
    const config={httpPort:0,mqttPort:0,operatorPin:'12345678',devices:[]};
    app=await createApp({config,effectsDir,dataDir:path.join(dir,'data'),bind:'127.0.0.1'});
    const base=`http://127.0.0.1:${app.httpServer.address().port}`;
    assert.deepEqual((await (await fetch(`${base}/api/state`)).json()).soundFiles,{});
    writeFileSync(path.join(effectsDir,'shot.wav'),Buffer.from('sample'));
    let files=(await (await fetch(`${base}/api/state`)).json()).soundFiles;
    assert.match(files.shot,/^\/effects\/shot\.wav\?v=/);
    assert.equal((await fetch(`${base}${files.shot}`)).status,200);
    assert.equal((await fetch(`${base}/effects/unknown.wav`)).status,404);
    assert.equal((await fetch(`${base}/effects/shot.mp3`)).status,404);
    const previous=files.shot;
    writeFileSync(path.join(effectsDir,'shot.wav'),Buffer.from('new sample'));
    utimesSync(path.join(effectsDir,'shot.wav'),new Date(0),new Date(Date.now()+1000));
    files=(await (await fetch(`${base}/api/state`)).json()).soundFiles;
    assert.notEqual(files.shot,previous);
    writeFileSync(path.join(effectsDir,'shot.mp3'),Buffer.from('mp3 sample'));
    files=(await (await fetch(`${base}/api/state`)).json()).soundFiles;
    assert.match(files.shot,/^\/effects\/shot\.mp3\?v=/);
  } finally {
    await app?.close();
    rmSync(dir,{recursive:true,force:true});
  }
});
