// Small Leaflet-shaped surface shared by the journey, calibration and friend maps.
// Kakao is loaded only after the user enables the online map.
export function createMapAPI({key = '', leaflet, document = globalThis.document, window = globalThis.window}) {
  if (!key.trim()) return leaflet;
  let sdkPromise;
  const load = () => sdkPromise ||= new Promise((resolve,reject) => {
    const script = document.createElement('script');
    let settled = false;
    const finish = error => {
      if (settled) return; settled = true; clearTimeout(timer);
      if (error) { script.remove(); sdkPromise = null; reject(error); }
      else resolve(window.kakao.maps);
    };
    const timer = setTimeout(() => finish(new Error('Kakao 지도 연결 시간이 초과됐어요.')),15000);
    script.src = `https://dapi.kakao.com/v2/maps/sdk.js?appkey=${encodeURIComponent(key)}&autoload=false`;
    script.onerror = () => finish(new Error('Kakao 지도를 불러오지 못했어요. JavaScript 키와 등록 도메인을 확인해 주세요.'));
    script.onload = () => {
      if (!window.kakao?.maps?.load) return finish(new Error('Kakao 지도 SDK가 준비되지 않았어요.'));
      window.kakao.maps.load(() => finish());
    };
    document.head.append(script);
  });
  const level = zoom => Math.max(1,Math.min(14,19-zoom));
  const latLng = (k,p) => new k.LatLng(p[0],p[1]);
  class MapView {
    constructor(id) { this.element=document.getElementById(id); this.point=[37.5665,126.978];this.zoom=15;this.groups=new Set();this.events=new Map();this.enabled=false;this.instance=null;this.generation=0; }
    setView(point,zoom) {this.point=point;this.zoom=zoom;this.bounds=null;if(this.instance){this.instance.setLevel(level(zoom));this.instance.setCenter(latLng(this.k,point));}return this;}
    invalidateSize() { if(this.instance){this.instance.relayout();this.instance.setCenter(latLng(this.k,this.point));}return this; }
    on(type,callback) {this.events.set(type,callback);return this;}
    fitBounds(points,options={}) {this.bounds={points,options};if(this.instance){const b=new this.k.LatLngBounds();points.forEach(p=>b.extend(latLng(this.k,p)));const tl=options.paddingTopLeft||[40,40],br=options.paddingBottomRight||[40,40];this.instance.setBounds(b,tl[1],br[0],br[1],tl[0]);if(options.maxZoom && this.instance.getLevel()<level(options.maxZoom))this.instance.setLevel(level(options.maxZoom));this.point=[this.instance.getCenter().getLat(),this.instance.getCenter().getLng()];}return this;}
    async enable() {
      this.enabled=true;const generation=++this.generation;const k=await load();
      if(!this.enabled || generation!==this.generation || this.instance)return;
      this.k=k;this.instance=new k.Map(this.element,{center:latLng(k,this.point),level:level(this.zoom)});
      if(this.zoomControl)this.instance.addControl(new k.ZoomControl(),k.ControlPosition.RIGHT);
      this.clickHandler=e=>this.events.get('click')?.({latlng:{lat:e.latLng.getLat(),lng:e.latLng.getLng()}});
      this.centerHandler=()=>{this.zoom=19-this.instance.getLevel();this.point=[this.instance.getCenter().getLat(),this.instance.getCenter().getLng()];};
      k.event.addListener(this.instance,'click',this.clickHandler);
      k.event.addListener(this.instance,'center_changed',this.centerHandler);
      for(const group of this.groups)group.render();
      if(this.bounds)this.fitBounds(this.bounds.points,this.bounds.options);
    }
    disable() {this.enabled=false;this.generation++;for(const group of this.groups)group.hide();if(this.instance){this.k.event.removeListener(this.instance,'click',this.clickHandler);this.k.event.removeListener(this.instance,'center_changed',this.centerHandler);this.instance=null;this.element.replaceChildren();}}
  }
  class Group {
    constructor(){this.items=new Set();}
    addTo(map){this.map=map;map.groups.add(this);this.render();return this;}
    clearLayers(){this.hide();this.items.clear();return this;}
    render(){if(this.map?.instance)for(const item of this.items)item.render(this.map);}
    hide(){for(const item of this.items)item.hide();}
  }
  class Item {
    constructor(type,data,options){this.type=type;this.data=data;this.options=options;}
    bindPopup(content){this.popup=content;return this;}
    addTo(group){group.items.add(this);if(group.map?.instance)this.render(group.map);return this;}
    hide(){this.overlay?.setMap(null);this.info?.close();this.overlay=null;this.info=null;}
    render(map){
      this.hide();const k=map.k,o=this.options;
      if(this.type==='line'){this.overlay=new k.Polyline({map:map.instance,path:this.data.map(p=>latLng(k,p)),strokeColor:o.color,strokeWeight:o.weight,strokeOpacity:o.opacity,strokeStyle:o.dashArray?'shortdash':'solid'});return;}
      const content=document.createElement('button');content.type='button';content.className=o.icon.className;content.setAttribute('aria-label',o.alt||'지도 위치');content.style.cssText='width:22px;height:22px;padding:0;border:0;background:transparent;cursor:pointer';
      // Icon HTML is internal static markup, never a search result or friend name.
      content.innerHTML=o.icon.html;
      content.addEventListener('click',event=>{event.stopPropagation();k.event.preventMap();if(this.popup){this.info ||= new k.InfoWindow({content:this.popup});this.info.setPosition(latLng(k,this.data));this.info.open(map.instance);}});
      this.overlay=new k.CustomOverlay({map:map.instance,position:latLng(k,this.data),content,xAnchor:.5,yAnchor:.5,zIndex:2});
    }
  }
  return {
    map:id=>new MapView(id),layerGroup:()=>new Group(),divIcon:options=>options,latLngBounds:points=>points,
    marker:(point,options)=>new Item('marker',point,options),polyline:(points,options)=>new Item('line',points,options),
    control:{zoom:()=>({addTo(map){map.zoomControl=true;return this;}})},
    tileLayer:()=>({handlers:{},addTo(map){this.map=map;map.enable().catch(error=>{if(map.enabled)this.handlers.tileerror?.(error);});return this;},remove(){this.map?.disable();},on(type,handler){this.handlers[type]=handler;return this;}}),
  };
}
