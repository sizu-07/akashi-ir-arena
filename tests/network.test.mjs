import test from 'node:test';
import assert from 'node:assert/strict';
import {tabletAddressOf} from '../apps/server/main.mjs';

test('tablet QR prefers the PC Wi-Fi address over the board Ethernet address',()=>{
  const interfaces={
    'イーサネット 2':[{family:'IPv4',internal:false,address:'192.168.137.1'}],
    'Wi-Fi':[{family:'IPv4',internal:false,address:'172.16.36.48'}],
  };
  assert.equal(tabletAddressOf(interfaces),'172.16.36.48');
});
