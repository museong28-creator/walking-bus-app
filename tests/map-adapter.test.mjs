import test from 'node:test';
import assert from 'node:assert/strict';
import {createMapAPI} from '../src/map-adapter.js';
function fake() {
  const scripts=[],maps=[],overlays=[],elements=new globalThis.Map();
  const element=()=>({style:{},setAttribute(){},addEventListener(type,fn){(this.events ||= {})[type]=fn;},replaceChildren(){this.cleared=true;},remove(){this.removed=true;}});
  const document={createElement:element,getElementById(id){if(!elements.has(id))elements.set(id,element());return elements.get(id);},head:{append(script){scripts.push(script);}}};
  class LatLng{constructor(lat,lng){this.lat=lat;this.lng=lng;}getLat(){return this.lat;}getLng(){return this.lng;}}
  class Map{constructor(element,{center,level}){this.center=center;this.level=level;this.events={};maps.push(this);}setCenter(p){this.center=p;}getCenter(){return this.center;}setLevel(l){this.level=l;}getLevel(){return this.level;}addControl(){}relayout(){}setBounds(b){this.center=b.points[0];}}
  class Overlay{constructor(options){this.map=options.map;this.content=options.content;overlays.push(this);}setMap(map){this.map=map;}}
  const k={load:cb=>cb(),Map,LatLng,LatLngBounds:class {points=[];extend(p){this.points.push(p);}},Polyline:Overlay,CustomOverlay:Overlay,ZoomControl:class{},ControlPosition:{RIGHT:1},event:{preventMap(){},addListener(map,event,fn){map.events[event]=fn;},removeListener(map,event){delete map.events[event];}}};
  return {document,scripts,maps,overlays,window:{kakao:{maps:k}}};
}
test('blank public key uses existing Leaflet without any SDK requests',()=>{const leaflet={};assert.equal(createMapAPI({leaflet}),leaflet);});
test('Kakao is lazy, preserves selected points/markers, and relays destination clicks',async()=>{
  const f=fake(),api=createMapAPI({key:'public-js-key',...f}),map=api.map('map').setView([35,129],16),group=api.layerGroup().addTo(map);
  api.marker([35,129],{icon:api.divIcon({className:'point-marker',html:'<div></div>'}),alt:'현재 위치'}).addTo(group);
  let selected;map.on('click',e=>selected=e.latlng);assert.equal(f.scripts.length,0);assert.equal(f.maps.length,0);
  const pending=map.enable();assert.equal(f.scripts.length,1);assert.match(f.scripts[0].src,/autoload=false/);f.scripts[0].onload();await pending;
  assert.equal(f.maps.length,1);assert.equal(f.maps[0].center.getLat(),35);assert.equal(f.overlays.length,1);
  f.maps[0].events.click({latLng:new f.window.kakao.maps.LatLng(36,128)});assert.deepEqual(selected,{lat:36,lng:128});
  group.clearLayers();assert.equal(f.overlays[0].map,null);map.disable();assert.equal(map.instance,null);assert.equal(f.maps[0].events.click,undefined);
});
test('turning off while SDK loads prevents late map creation; enabling again reuses SDK',async()=>{
  const f=fake(),api=createMapAPI({key:'public-key',...f}),map=api.map('map');const p=map.enable();map.disable();f.scripts[0].onload();await p;assert.equal(f.maps.length,0);await map.enable();assert.equal(f.maps.length,1);assert.equal(f.scripts.length,1);map.disable();
});
test('SDK load errors are reported and a deliberate retry can load again',async()=>{
  const f=fake(),api=createMapAPI({key:'public-key',...f}),map=api.map('map');const p=map.enable();f.scripts[0].onerror();await assert.rejects(p,/JavaScript 키/);const retry=map.enable();assert.equal(f.scripts.length,2);f.scripts[1].onload();await retry;map.disable();
});
test('main and calibration share one SDK script and separate map state',async()=>{
  const f=fake(),api=createMapAPI({key:'public-key',...f}),a=api.map('main'),b=api.map('calibration').setView([37,127],17);const x=a.enable(),y=b.enable();assert.equal(f.scripts.length,1);f.scripts[0].onload();await Promise.all([x,y]);assert.equal(f.maps.length,2);assert.equal(b.instance.getLevel(),2);a.disable();assert.notEqual(b.instance,null);b.disable();
});
test('Kakao place search loads services lazily and returns real place names/addresses without GPS',async()=>{
  const f=fake();let call;
  f.window.kakao.maps.services={Status:{OK:'OK',ZERO_RESULT:'ZERO_RESULT'},Places:class{keywordSearch(...args){call=args;}}};
  const api=createMapAPI({key:'public-key',...f});const pending=api.searchPlaces(' 서울역 ');
  assert.match(f.scripts[0].src,/libraries=services/);f.scripts[0].onload();await Promise.resolve();await Promise.resolve();
  assert.equal(call[0],'서울역');assert.deepEqual(call[2],{size:10});
  call[1]([{place_name:'서울역',road_address_name:'서울 용산구',x:'126.97',y:'37.55'},null,{x:'',y:'37'}],'OK');
  assert.deepEqual(await pending,[{name:'서울역',address:'서울 용산구',point:[37.55,126.97],source:'Kakao 장소 검색'}]);assert.equal(f.maps.length,0);
});
test('Kakao search empty, failed and cancelled requests settle without stale results',async()=>{
  const f=fake();let cb;f.window.kakao.maps.services={Status:{OK:'OK',ZERO_RESULT:'ZERO_RESULT'},Places:class{keywordSearch(q,callback){cb=callback;}}};
  const api=createMapAPI({key:'public-key',...f});const controller=new AbortController();
  const cancelled=api.searchPlaces('서울역',controller.signal);f.scripts[0].onload();await Promise.resolve();await Promise.resolve();controller.abort();await assert.rejects(cancelled,{name:'AbortError'});cb([],'OK');
  const empty=api.searchPlaces('없는장소');await Promise.resolve();cb([],'ZERO_RESULT');assert.deepEqual(await empty,[]);
  const failed=api.searchPlaces('서울역');await Promise.resolve();cb(null,'ERROR');await assert.rejects(failed,/사용 권한/);
  await assert.rejects(api.searchPlaces('a'),/2~180/);
});

test('Kakao stop marker dispatches selection without throwing or selecting the underlying map',async()=>{
  const f=fake(),api=createMapAPI({key:'public-key',...f}),map=api.map('map'),group=api.layerGroup().addTo(map);
  let calls=0,stopped=false;api.marker([37,127],{icon:{className:'stop',html:'<div>▣</div>'},alt:'Test stop'}).on('click',()=>calls++).addTo(group);
  const p=map.enable();f.scripts[0].onload();await p;
  f.overlays[0].content.events.click({stopPropagation(){stopped=true;}});assert.equal(calls,1);assert.equal(stopped,true);
});
