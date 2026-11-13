import test from 'node:test';
import assert from 'node:assert/strict';
import {nextManeuver} from '../src/navigation.js';
const route={distance:200,steps:[{at:0,type:'depart'},{at:100,type:'turn',modifier:'right',name:'길'},{at:200,type:'arrive'}]};
test('next real maneuver uses remaining route distance, not direct distance',()=>{assert.deepEqual(nextManeuver(route,{remaining:150}),{meters:50,instruction:'오른쪽으로 이동',name:'길'});});
test('passed maneuver advances to arrival',()=>{assert.match(nextManeuver(route,{remaining:80}).instruction,/목적지/);});
test('missing direction data is not invented',()=>{assert.equal(nextManeuver({distance:100},{remaining:20}),null);assert.equal(nextManeuver(route,null),null);});
test('roundabout never fabricates exit number',()=>{assert.match(nextManeuver({distance:100,steps:[{at:50,type:'roundabout',modifier:'right'}]},{remaining:100}).instruction,/현장 표지/);});
