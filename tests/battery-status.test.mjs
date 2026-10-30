import test from 'node:test';
import assert from 'node:assert/strict';
import {batteryStatus} from '../apps/web/battery-status.js';
import {Game} from '../apps/server/game.mjs';

test('operator battery display shows the voltage only as a reference and never warns',()=>{
  const player={battery:9,connected:true,batteryReplaceVoltage:7,lowBattery:false};
  assert.deepEqual(batteryStatus(player),{text:'電池 9.00 V（参考値）',warning:false,status:''});
  for(const battery of [7.01,7,6.5,0.6])assert.deepEqual(batteryStatus({...player,battery}),{text:`電池 ${battery.toFixed(2)} V（参考値）`,warning:false,status:''});
  assert.equal(batteryStatus({...player,lowBattery:true}).warning,false);
  assert.equal(batteryStatus({...player,connected:false}).text,'電池 9.00 V（参考値）（最終受信）');
  assert.equal(batteryStatus({...player,battery:null}).text,'電池 未測定');
  assert.equal(batteryStatus({...player,battery:null}).warning,false);
});

test('server preserves measured voltage and replacement threshold; receiver-only reports no reading',()=>{
  const g=new Game([{id:'gun-001',name:'P1',shooterId:1}]);
  g.heartbeat('gun-001',{battery:7,battery_replace_v:7,lowBattery:true});
  assert.equal(g.view().players[0].battery,7);assert.equal(g.view().players[0].batteryReplaceVoltage,7);
  assert.equal(batteryStatus(g.view().players[0]).warning,false);
  g.heartbeat('gun-001',{});assert.equal(g.player('gun-001').battery,null);
  assert.equal(g.player('gun-001').batteryReplaceVoltage,null);
  g.heartbeat('gun-001',{battery:-1,battery_replace_v:99});assert.equal(g.player('gun-001').battery,null);
  assert.equal(g.player('gun-001').batteryReplaceVoltage,null);
});
