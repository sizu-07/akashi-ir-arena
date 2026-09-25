import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, writeFileSync, readdirSync, readFileSync, rmSync} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {storage} from '../apps/server/store.mjs';

test('broken snapshot is preserved and a fresh game can be saved', () => {
  const dir=mkdtempSync(path.join(os.tmpdir(),'arena-snapshot-'));
  const original=Buffer.alloc(2725);
  try {
    writeFileSync(path.join(dir,'snapshot.json'),original);
    writeFileSync(path.join(dir,'events.jsonl'),'{"type":"old_event"}\n');
    const db=storage(dir);
    const warn=console.warn;console.warn=()=>{};
    try {assert.equal(db.load(),null);} finally {console.warn=warn;}
    const backups=readdirSync(dir).filter(name=>name.startsWith('snapshot.corrupt-'));
    assert.equal(backups.length,1);
    assert.deepEqual(readFileSync(path.join(dir,backups[0])),original);
    assert.equal(readFileSync(path.join(dir,'events.jsonl'),'utf8'),'{"type":"old_event"}\n');
    db.save({players:[]});
    assert.deepEqual(db.load(),{players:[]});
  } finally {rmSync(dir,{recursive:true,force:true});}
});
