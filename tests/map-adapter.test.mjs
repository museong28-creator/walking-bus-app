import test from 'node:test';
import assert from 'node:assert/strict';
import {createMapAPI} from '../src/map-adapter.js';
function fake() {
  const scripts=[],maps=[],overlays=[],elements=new globalThis.Map();
  const element=()=>({style:{},setAttribute(){},addEventListener(){},replaceChildren(){this.cleared=true;},remove(){this.removed=true;}});
  const document={createElement:element,getElementById(id){if(!elements.has(id))elements.set(id,element());return elements.get(id);},head:{append(script){scripts.push(script);}}};
  class LatLng{constructor(lat,lng){this.lat=lat;this.lng=lng;}getLat(){return this.lat;}getLng(){return this.lng;}}
  class Map{constructor(element,{center,level}){this.center=center;this.level=level;this.events={};maps.push(this);}setCenter(p){this.center=p;}getCenter(){return this.center;}setLevel(l){this.level=l;}getLevel(){return this.level;}addControl(){}relayout(){}setBounds(b){this.center=b.points[0];}}
  class Overlay{constructor(options){this.map=options.map;overlays.push(this);}setMap(map){this.map=map;}}
  const k={load:cb=>cb(),Map,LatLng,LatLngBounds:class {points=[];extend(p){this.points.push(p);}},Polyline:Overlay,CustomOverlay:Overlay,ZoomControl:class{},ControlPosition:{RIGHT:1},event:{addListener(map,event,fn){map.events[event]=fn;},removeListener(map,event){delete map.events[event];}}};
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
