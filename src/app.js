import {DEFAULT_SPEED, SpeedTracker, distance, pathDistance, projectOnRoute, etaSeconds, catchStatus, parseCoordinates} from './core.js';
import {SERVICES, getWalkingRoute, searchPlaces, getNearbyStops} from './services.js';
import {initMeetupUI} from './meetup-ui.js';

const $ = id => document.getElementById(id);
const tracker = new SpeedTracker();
const calibration = {active:false, done:false, started:0, first:0, values:[], accuracy:null, message:'', lastSample:0};
function renderCalibration() {
  const active = calibration.active;
  const fresh = state.tracking && state.lastGoodFix && Date.now() - state.lastGoodFix <= 15000;
  const usable = fresh && tracker.status === 'measured' && tracker.current >= 0.4;
  const ready = usable && calibration.values.length >= 6 && calibration.lastSample - calibration.first >= 30000;
  $('onboarding-speed').textContent = calibration.done ? (state.baseSpeed * 3.6).toFixed(1) : usable && active ? (tracker.current * 3.6).toFixed(1) : '—';
  $('onboarding-speed-label').textContent = calibration.done ? '이번 측정 평균 속도' : '현재 보행 속도';
  $('onboarding-status').textContent = calibration.done ? '✓ 측정 완료' : !active ? '● 측정 준비' : !state.tracking ? 'Ⅱ 측정 중지' : !fresh ? '● 위치 신호 기다리는 중' : ready ? '● 적용할 준비가 됐어요' : '● 내 걸음 측정 중';
  $('onboarding-pace').textContent = calibration.done ? '목적지를 정해볼까요?' : usable && active ? 'GPS 기반 추정 속도' : '보행 표본을 기다려요';
  const elapsed = active && calibration.started ? Math.max(0, Math.floor(((state.tracking ? Date.now() : calibration.stopped) - calibration.started) / 1000)) : 0;
  $('onboarding-time').textContent = `${String(Math.floor(elapsed / 60)).padStart(2,'0')}:${String(elapsed % 60).padStart(2,'0')}`;
  $('onboarding-accuracy').textContent = calibration.accuracy === null ? '—' : `±${Math.round(calibration.accuracy)} m`;
  $('onboarding-finish').classList.toggle('hidden', !active || calibration.done);
  $('onboarding-finish').disabled = !ready;
  $('onboarding-start').classList.toggle('hidden', active && state.tracking || calibration.done);
  $('onboarding-start').textContent = active ? '↻ 다시 측정하기' : '◎ 내 위치 측정하기';
  $('onboarding-stop').classList.toggle('hidden', !active || !state.tracking);
  if (calibration.message) $('onboarding-feedback').textContent = calibration.message;
}
function leaveOnboarding() {
  calibration.active = false;
  if (!state.mapEnabled && !state.demo) $('map-gate').classList.remove('hidden');
  document.body?.classList.remove('onboarding');
  $('onboarding-card').classList.add('hidden');
  map.invalidateSize?.();
  window.scrollTo?.({top:0,behavior:'auto'});
}
$('onboarding-start').addEventListener('click', () => {
  if (state.tracking) stopTracking();
  Object.assign(calibration,{active:true,done:false,started:Date.now(),first:0,values:[],lastSample:0,accuracy:null,message:'내 위치를 찾고 있어요. 브라우저의 위치 권한을 허용해 주세요.'});
  $('onboarding-map-view').classList.add('hidden');
  startTracking(); renderCalibration();
});
$('onboarding-stop').addEventListener('click', () => {stopTracking(); notice('측정을 멈췄어요. 다시 시작하면 새로운 표본으로 측정해요.');render();});
$('onboarding-finish').addEventListener('click', () => {
  if ($('onboarding-finish').disabled) return;
  state.baseSpeed = calibration.values.reduce((a,b)=>a+b,0) / calibration.values.length;
  $('base-speed').value = (state.baseSpeed * 3.6).toFixed(1);
  $('base-speed-value').textContent = `${(state.baseSpeed * 3.6).toFixed(1)} km/h`;
  calibration.done = true; state.speedOrigin = 'calibrated'; stopTracking();
  calibration.message = `측정 완료! 이번 보행의 평균은 시속 ${(state.baseSpeed * 3.6).toFixed(1)}km예요. 목적지를 선택하고 도보 경로를 찾아보세요. 이후 ETA는 이 설정 속도로 계산해요.`;
  $('onboarding-title').textContent = '나만의 속도를 찾았어요.';
  $('onboarding-copy').textContent = '신호 대기, 경사와 GPS 오차에 따라 실제 도착 시간은 달라질 수 있어요.';
  $('onboarding-skip').textContent = '이 속도로 목적지 선택하기 →'; $('onboarding-skip').classList.add('ob-primary'); render();
});
$('onboarding-skip').addEventListener('click', () => {if (state.tracking) stopTracking();leaveOnboarding();render();});
$('recalibrate-button').addEventListener('click', () => {
  if (state.tracking) stopTracking();
  $('onboarding-skip').classList.remove('ob-primary'); $('onboarding-skip').textContent = '나중에 측정하고 지도 보기 →';
  $('onboarding-map-view').classList.add('hidden'); calibration.accuracy = null;
  document.body?.classList.add('onboarding');$('onboarding-card').classList.remove('hidden');
  calibration.done = false; calibration.active = false; calibration.message = '측정하기를 누르면 새로운 표본으로 시작해요.';
  $('onboarding-title').textContent = '내 걸음 속도 측정하기';
  renderCalibration();map.invalidateSize?.();window.scrollTo?.({top:0,behavior:'smooth'});
});
$('onboarding-theme').addEventListener('click', () => {
  const light = document.body?.classList.toggle('ob-light');
  $('onboarding-theme').setAttribute?.('aria-label', light ? '어두운 화면으로 전환' : '밝은 화면으로 전환');
});
$('journey-theme').addEventListener('click', () => document.body?.classList.toggle('ob-light'));
const state = {start:null, position:null, destination:null, route:null, tracking:false, watchId:null, watchEpoch:0,
  speedOrigin:'default', baseSpeed:4.3 / 3.6, mapEnabled:false, pickingStart:false, demo:false, demoProgress:0, demoSpeed:DEFAULT_SPEED,
  busArrival:null, requestEpoch:0, routeBusy:false, stopBusy:false, lastGoodFix:0, wakeLock:null};
let routeController, searchController, stopController, pendingConsent;
let meetingUI = null;
let lastTick = Date.now();

const map = L.map('map', {zoomControl:false, attributionControl:true}).setView([37.5665,126.9780],15);
L.control.zoom({position:'bottomright'}).addTo(map);
const tiles = L.tileLayer(SERVICES.tiles, {maxZoom:19, attribution:'© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors'});
const pathLayer = L.layerGroup().addTo(map), markerLayer = L.layerGroup().addTo(map), stopLayer = L.layerGroup().addTo(map);
const calibrationMap = L.map('onboarding-map-view',{zoomControl:false,attributionControl:true}).setView([37.5665,126.9780],15);
const calibrationLayer = L.layerGroup().addTo(calibrationMap);
const calibrationTiles = L.tileLayer(SERVICES.tiles,{maxZoom:19,attribution:'© OpenStreetMap contributors'});
function showCalibrationLocation(point, accuracy) {
  if (!calibration.active) return;
  $('onboarding-map-view').classList.remove('hidden');
  calibrationMap.invalidateSize?.(); calibrationMap.setView(point,accuracy > 40 ? 14 : 17);
  calibrationLayer.clearLayers(); marker(point,'current',`내 위치 · GPS 오차 약 ${Math.round(accuracy)}m`).addTo(calibrationLayer);
}


function notice(message = '') { if (calibration.active && message) {calibration.message = message; $('onboarding-feedback').textContent = message;} $('notice').textContent = message; $('notice').classList.toggle('hidden', !message); }
function shortDistance(meters) { return meters >= 1000 ? `${(meters / 1000).toFixed(2)} km` : `${Math.round(meters)} m`; }
function formatTime(timestamp) { return new Intl.DateTimeFormat('ko-KR', {hour:'numeric',minute:'2-digit'}).format(timestamp); }
function coordinateLabel(point) { return `${point[0].toFixed(5)}, ${point[1].toFixed(5)}`; }
function marker(point, kind, label) {
  const icon = L.divIcon({className:`point-marker ${kind}`,html:`<div>${kind === 'stop' ? '▣' : ''}</div>`,iconSize:[22,22],iconAnchor:[11,11]});
  const item = L.marker(point,{icon,keyboard:true,alt:label});
  const content = document.createElement('span'); content.textContent = label;
  return item.bindPopup(content);
}
function draw() {
  pathLayer.clearLayers(); markerLayer.clearLayers();
  if (state.route) L.polyline(state.route.points,{color:'#2455dc',weight:5,opacity:.9,lineCap:'round'}).addTo(pathLayer);
  else if (state.position && state.destination) L.polyline([state.position,state.destination.point],{color:'#879ab6',weight:3,dashArray:'5 8',opacity:.6}).addTo(pathLayer);
  if (state.position) marker(state.position,'current',state.demo ? '가상 현재 위치' : state.tracking ? '현재 위치' : '설정한 출발지').addTo(markerLayer);
  if (state.destination) marker(state.destination.point,'destination',state.destination.name).addTo(markerLayer);
}
function fitMap() {
  const points = state.route?.points || [state.position,state.destination?.point].filter(Boolean);
  if (points.length > 1) map.fitBounds(L.latLngBounds(points),{paddingTopLeft:[55,110],paddingBottomRight:[50,100],maxZoom:17});
  else if (points.length) map.setView(points[0],16);
}
function clearRequests() {
  state.requestEpoch++;
  routeController?.abort(); stopController?.abort(); searchController?.abort();
  state.routeBusy = false; state.stopBusy = false;
  $('search-button').disabled = false;
  $('search-results').classList.add('hidden');
  if (pendingConsent) finishConsent(false);
}
function askConsent(title, text, footnote = '이 요청을 진행할 때만 연결해요. GPS 이동 기록은 저장하지 않아요.') {
  if (pendingConsent) return Promise.resolve(false);
  $('consent-title').textContent = title; $('consent-copy').textContent = text;
  $('consent-footnote').textContent = footnote;
  return new Promise(resolve => { pendingConsent = resolve; $('consent-dialog').showModal(); });
}
function finishConsent(allowed) {
  const resolve = pendingConsent; pendingConsent = null;
  if ($('consent-dialog').open) $('consent-dialog').close();
  resolve?.(allowed);
}
$('consent-allow').addEventListener('click', () => finishConsent(true));
$('consent-cancel').addEventListener('click', () => finishConsent(false));
$('consent-dialog').addEventListener('cancel', event => { event.preventDefault(); finishConsent(false); });

function enableMap() {
  if (state.mapEnabled) return;
  state.mapEnabled = true; calibrationTiles.addTo(calibrationMap); tiles.addTo(map); $('map-gate').classList.add('hidden');
  $('map-caption').textContent = state.position ? '지도: OpenStreetMap · 실제 현장 상황과 다를 수 있어요' : '초기 지도: 서울 시청 · 현재 위치가 아니에요';
}
$('enable-map').addEventListener('click', enableMap);
$('onboarding-map').addEventListener('click', enableMap);
$('disable-map').addEventListener('click', () => {
  tiles.remove(); calibrationTiles.remove(); state.mapEnabled = false;
  $('map-caption').textContent = '온라인 지도 꺼짐 · 새 지도 타일을 요청하지 않아요';
  if (!state.demo) $('map-gate').classList.remove('hidden');
  notice('온라인 지도를 껐어요. 이미 요청한 지도 타일은 브라우저에 남을 수 있어요.');
});
let tileWarning = false;
tiles.on('tileerror', () => { if (!tileWarning) { tileWarning = true; notice('지도 타일을 불러오지 못했어요. 네트워크를 확인하거나 좌표 입력을 사용해 주세요.'); } });

function setDestination(point, name, source = '지도에서 선택한 지점') {
  meetingUI?.destinationChanged(point);
  clearRequests(); state.destination = {point,name,source}; state.route = null; state.busArrival = null;
  $('destination-name').textContent = name;
  $('destination-detail').textContent = `${source} · ${coordinateLabel(point)}`;
  $('clear-destination').classList.remove('hidden');
  $('search-results').classList.add('hidden');
  $('map-tip').textContent = state.position ? '목적지를 정했어요. 도보 경로를 찾아보세요' : '출발지를 정하거나 내 위치로 걷기를 시작하세요';
  notice(); draw(); render();
}
$('clear-destination').addEventListener('click', () => {
  meetingUI?.destinationChanged(null);
  if (state.demo) exitDemo();
  clearRequests(); state.destination = null; state.route = null; state.busArrival = null;
  $('destination-name').textContent = '지도에서 목적지를 선택해 주세요';
  $('destination-detail').textContent = '장소 검색이나 좌표 입력도 가능해요';
  $('clear-destination').classList.add('hidden'); $('map-tip').textContent = '지도를 눌러 목적지를 정하세요';
  draw(); render();
});
map.on('click', event => {
  if (state.demo) { notice('가상 체험 중이에요. 체험을 종료하면 목적지를 바꿀 수 있어요.'); return; }
  const point = [event.latlng.lat,event.latlng.lng];
  if (state.pickingStart) {
    stopTracking(); clearRequests(); tracker.reset();
    state.start = point; state.position = point; state.route = null; state.pickingStart = false;
    $('set-start').textContent = '출발지 지정'; $('map-tip').textContent = '이제 지도에서 목적지를 선택해 주세요';
    notice('출발지를 직접 정했어요. 실제 걷기 속도를 쓰려면 위치 측정을 시작해 주세요.');
    draw(); render();
  } else setDestination(point,'지도에서 선택한 목적지');
});
$('set-start').addEventListener('click', () => {
  if (state.demo) exitDemo();
  state.pickingStart = !state.pickingStart;
  $('set-start').textContent = state.pickingStart ? '출발지 지정 취소' : '출발지 지정';
  $('map-tip').textContent = state.pickingStart ? '지도를 눌러 출발지를 정하세요' : '지도를 눌러 목적지를 정하세요';
  if (!state.mapEnabled) notice('온라인 지도를 켠 뒤 출발지를 선택해 주세요. 위치 정보 전송 없이 체험할 수도 있어요.');
});
$('fit-map').addEventListener('click', fitMap);

$('search-form').addEventListener('submit', async event => {
  event.preventDefault(); const query = $('search-input').value.trim();
  if (!query) return;
  if (state.demo) exitDemo();
  const coordinates = parseCoordinates(query);
  if (coordinates) { setDestination(coordinates,'좌표로 정한 목적지','직접 입력'); map.setView(coordinates,16); return; }
  if (!(await askConsent('장소 이름 검색', `입력한 검색어 “${query}”를 Nominatim (nominatim.openstreetmap.org)에 보내요. 현재 GPS 위치는 보내지 않아요. 검색어에 집 주소 등 개인정보가 포함될 수 있어요.`))) return;
  searchController?.abort(); searchController = new AbortController();
  const controller = searchController, epoch = state.requestEpoch;
  $('search-button').disabled = true; notice('장소를 찾고 있어요…');
  try {
    const results = await searchPlaces(query, controller.signal);
    if (epoch !== state.requestEpoch || controller.signal.aborted) return;
    $('search-results').replaceChildren();
    for (const result of results) {
      const li = document.createElement('li'), button = document.createElement('button');
      button.type = 'button'; button.textContent = result.name;
      button.addEventListener('click', () => { setDestination(result.point,result.name,'Nominatim 검색'); map.setView(result.point,16); });
      li.append(button); $('search-results').append(li);
    }
    $('search-results').classList.toggle('hidden',results.length === 0);
    notice(results.length ? '' : '검색 결과가 없어요. 더 구체적인 주소, 지도 선택 또는 위도, 경도를 사용해 주세요.');
  } catch (error) { if (!controller.signal.aborted) notice(`검색을 완료하지 못했어요. ${error.message}`); }
  finally { if (controller === searchController) $('search-button').disabled = false; }
});
document.addEventListener('keydown', event => { if (event.key === 'Escape') $('search-results').classList.add('hidden'); });

async function requestWakeLock(epoch) {
  try {
    if ('wakeLock' in navigator && document.visibilityState === 'visible') {
      const lock = await navigator.wakeLock.request('screen');
      if (!state.tracking || epoch !== state.watchEpoch) { await lock.release(); return; }
      state.wakeLock = lock;
      lock.addEventListener('release', () => { if (state.wakeLock === lock) state.wakeLock = null; });
    }
  } catch { if (state.tracking && epoch === state.watchEpoch) $('gps-note').textContent = '화면 자동 잠금을 막지 못했어요. 화면을 켜 두세요. 잠그거나 앱을 전환하면 측정이 중지돼요.'; }
}
function stopTracking() {
  calibration.stopped = Date.now();
  if (calibration.active && !calibration.done) calibration.message = '측정을 멈췄어요. 다시 측정하기를 누르면 새 표본으로 시작해요.';
  meetingUI?.pauseSharing('위치 측정이 중지되어 공유도 중지했어요.');
  state.watchEpoch++;
  if (state.watchId !== null) navigator.geolocation?.clearWatch(state.watchId);
  state.watchId = null; state.tracking = false;
  state.wakeLock?.release().catch(() => {}); state.wakeLock = null;
  $('gps-button').innerHTML = '<span aria-hidden="true">◎</span> 내 위치로 걷기 시작';
}
function startTracking() {
  if (state.tracking) return;
  if (!window.isSecureContext) { notice('위치 측정에는 HTTPS가 필요해요. GitHub Pages 주소 또는 localhost에서 열어 주세요.'); return; }
  if (!navigator.geolocation) { notice('이 브라우저는 위치 측정을 지원하지 않아요. 지도에서 출발지를 직접 정할 수 있어요.'); return; }
  if (state.demo) exitDemo();
  tracker.reset(); state.lastGoodFix = 0; state.tracking = true;
  const watchEpoch = ++state.watchEpoch;
  $('gps-button').innerHTML = '<span aria-hidden="true">Ⅱ</span> 걷기 측정 멈추기';
  $('gps-note').textContent = 'GPS는 기본적으로 이 기기에서 처리해요. 온라인 지도에는 표시 지역이 전달되고, 친구 위치 공유는 별도 동의 후 켜요.';
  notice('브라우저의 위치 권한을 허용해 주세요. 처음에는 정확한 위치를 잡는 데 시간이 걸릴 수 있어요.');
  render(); requestWakeLock(watchEpoch);
  let centered = false;
  try {
    state.watchId = navigator.geolocation.watchPosition(position => {
      if (!state.tracking || watchEpoch !== state.watchEpoch) return;
      if (Date.now() - position.timestamp > 15000 || position.timestamp > Date.now() + 5000) { notice('오래된 위치 정보가 도착했어요. 새 GPS 신호를 기다리고 있어요.'); render(); return; }
      const coords = position.coords;
      calibration.accuracy = Number.isFinite(coords.accuracy) ? coords.accuracy : null;
      const valid = tracker.ingest({latitude:coords.latitude,longitude:coords.longitude,accuracy:coords.accuracy,speed:coords.speed,timestamp:position.timestamp});
      if (!valid) {
        if (calibration.active && coords.accuracy > 40 && coords.accuracy <= 1000 && Number.isFinite(coords.latitude) && Number.isFinite(coords.longitude) && Math.abs(coords.latitude) <= 90 && Math.abs(coords.longitude) <= 180) {
          showCalibrationLocation([coords.latitude,coords.longitude],coords.accuracy);
          markerLayer.clearLayers(); marker([coords.latitude,coords.longitude],'current','대략적인 위치 · 속도 측정에는 사용하지 않아요').addTo(markerLayer);
          map.setView([coords.latitude,coords.longitude],14); $('map-gate').classList.add('hidden');
          $('map-caption').textContent = `대략적인 위치 · 오차 약 ${Math.round(coords.accuracy)}m · 속도 측정 보류`;
        }
        notice(`GPS 정확도가 낮거나 위치가 튀었어요. 탁 트인 곳에서 잠시 기다려 주세요. (오차 약 ${Math.round(coords.accuracy)}m)`); render(); return; }
      state.position = [coords.latitude,coords.longitude]; state.lastGoodFix = position.timestamp;
      showCalibrationLocation(state.position,coords.accuracy);
      if (calibration.active && !calibration.done) {
        const sample = tracker.samples.at(-1);
        if (tracker.status === 'measured' && sample && sample.value >= 0.4 && sample.timestamp > calibration.lastSample) {
          if (calibration.lastSample && sample.timestamp - calibration.lastSample > 15000) { calibration.values = []; calibration.first = 0; }
          if (!calibration.first) calibration.first = sample.timestamp;
          calibration.lastSample = sample.timestamp; calibration.values.push(sample.value);
        }
        calibration.message = tracker.status === 'stopped' ? '멈춰 있어요. 안전한 곳에서 평소처럼 다시 걸어주세요.' : '위치를 찾았어요. 화면을 켠 채 평소처럼 걸어주세요. 온라인 지도를 켜면 지도 배경과 내 위치를 함께 볼 수 있어요.';
        $('map-gate').classList.add('hidden');
      }
      if (!state.start) state.start = state.position;
      if (!centered) { map.setView(state.position,16); centered = true; }
      $('map-caption').textContent = `${state.mapEnabled ? 'OpenStreetMap' : '지도 타일 꺼짐'} · GPS 오차 약 ${Math.round(coords.accuracy)}m`;
      notice(tracker.status === 'too-fast' ? '보행 속도 범위를 벗어났어요. 걷기로 돌아오면 다시 측정해요.' : '');
      draw(); render();
    }, error => {
      if (!state.tracking || watchEpoch !== state.watchEpoch) return;
      if (error.code === 1) {
        stopTracking(); notice('위치 권한이 허용되지 않았어요. Safari의 이 웹사이트 위치 권한을 바꾸거나 지도에서 출발지를 직접 정해 주세요.');
      } else notice(error.code === 3 ? '위치 측정 시간이 초과됐어요. GPS 신호를 기다리는 중이에요.' : '지금 위치를 확인할 수 없어요. 네트워크와 위치 서비스를 확인해 주세요.');
      render();
    }, {enableHighAccuracy:true,maximumAge:0,timeout:20000});
  } catch { stopTracking(); notice('위치 측정을 시작하지 못했어요. 브라우저 위치 권한을 확인해 주세요.'); render(); }
}
$('gps-button').addEventListener('click', () => {
  if (state.tracking) { stopTracking(); notice('측정을 멈췄어요. 현재 위치는 마지막 측정 지점이며, ETA는 설정 속도 기준이에요.'); render(); }
  else startTracking();
});
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible' && state.tracking) {
    stopTracking(); notice('화면 잠금 또는 앱 전환으로 측정을 멈췄어요. 다시 걷기 시작을 눌러 주세요.'); render();
  }
  lastTick = Date.now();
});
window.addEventListener('pagehide', stopTracking);

$('route-button').addEventListener('click', async () => {
  if (!state.position || !state.destination || state.routeBusy || state.demo) return;
  const epoch = state.requestEpoch, start = [...state.position], end = [...state.destination.point];
  if (!(await askConsent('실제 도보 경로 찾기', '선택한 출발지와 목적지의 정확한 좌표를 FOSSGIS 도보 경로 서버 (routing.openstreetmap.de)에 보내요. 현재 위치를 출발지로 쓰면 현재 위치 좌표가 전송돼요. 이동 중에는 경로 서버로 자동 전송하지 않아요.'))) return;
  if (epoch !== state.requestEpoch) return;
  routeController?.abort(); routeController = new AbortController(); const controller = routeController;
  state.routeBusy = true; render(); notice('보행로를 따라가는 경로를 찾고 있어요…');
  try {
    const route = await getWalkingRoute(start,end,controller.signal);
    if (epoch !== state.requestEpoch || controller.signal.aborted) return;
    const firstGap = distance(start,route.points[0]), lastGap = distance(end,route.points.at(-1));
    state.route = {...route,distance:route.distance + firstGap + lastGap,points:[start,...route.points,end],endpointGap:Math.max(firstGap,lastGap)};
    $('map-tip').textContent = '내 걸음 속도에 맞춰 도착 시간이 달라져요';
    notice(route.snapDistance > 20 ? `선택한 지점과 보행로 사이에 최대 ${Math.round(route.snapDistance)}m 차이가 있어요. 연결 구간과 실제 출입구를 확인해 주세요.` : '');
    draw(); fitMap();
  } catch (error) {
    if (!controller.signal.aborted) { state.route = null; draw(); notice(`도보 경로를 불러오지 못했어요. ${error.message} 점선은 직선거리일 뿐, 도보 경로나 ETA가 아니에요.`); }
  } finally { if (controller === routeController) { state.routeBusy = false; render(); } }
});

$('stops-button').addEventListener('click', async () => {
  if (state.demo) { notice('체험 중에는 가상 위치를 외부로 보내지 않아요. 체험을 종료하고 출발지를 정해 주세요.'); return; }
  if (!state.position) { notice('주변 정류장을 찾으려면 먼저 내 위치를 확인하거나 출발지를 정해 주세요.'); return; }
  if (state.stopBusy) return;
  const epoch = state.requestEpoch, position = [...state.position];
  if (!(await askConsent('주변 정류장 검색', '출발지 또는 현재 위치의 정확한 좌표를 Overpass (overpass-api.de)에 보내 주변 700m의 OpenStreetMap 정류장을 찾아요. 모든 정류장을 포함하지 않으며, 버스 도착정보는 제공하지 않아요.'))) return;
  if (epoch !== state.requestEpoch) return;
  stopController?.abort(); stopController = new AbortController(); const controller = stopController;
  state.stopBusy = true; render(); notice('주변 정류장을 찾고 있어요…');
  try {
    const stops = (await getNearbyStops(position,controller.signal)).map(stop => ({...stop,distance:distance(position,stop.point)})).sort((a,b) => a.distance - b.distance).slice(0,8);
    if (epoch !== state.requestEpoch || controller.signal.aborted) return;
    $('stop-results').replaceChildren(); stopLayer.clearLayers();
    for (const stop of stops) {
      const choose = () => { setDestination(stop.point,stop.name,'OSM 버스 정류장'); fitMap(); };
      const button = document.createElement('button'), name = document.createElement('span'), meters = document.createElement('small');
      name.textContent = stop.name; meters.textContent = `직선 ${shortDistance(stop.distance)}`;
      button.append(name,meters); button.addEventListener('click',choose); $('stop-results').append(button);
      marker(stop.point,'stop',stop.name).on('click',choose).addTo(stopLayer);
    }
    $('stop-results').classList.toggle('hidden',stops.length === 0);
    notice(stops.length ? '정류장을 누르면 목적지가 돼요. 같은 이름이어도 방향이 다를 수 있으니 탑승 방향을 확인해 주세요.' : '700m 안에서 등록된 정류장을 찾지 못했어요. 정류장이 있어도 데이터에 누락될 수 있어요.');
  } catch (error) { if (!controller.signal.aborted) notice(`정류장을 불러오지 못했어요. ${error.message}`); }
  finally { if (controller === stopController) { state.stopBusy = false; render(); } }
});

$('bus-form').addEventListener('submit', event => {
  event.preventDefault();
  const minutes = Number($('bus-minutes').value);
  if (!Number.isFinite(minutes) || minutes < 1 || minutes > 180) { notice('1~180분 사이의 버스 도착 시간을 입력해 주세요.'); return; }
  if (!state.destination) { notice('먼저 탑승할 정류장을 목적지로 정해 주세요. 지도에서 직접 선택해도 돼요.'); return; }
  state.busArrival = Date.now() + minutes * 60000;
  meetingUI?.useBusTime?.(state.busArrival);
  notice('직접 입력한 시간과 현재 목적지까지의 도보 시간을 비교해요. 실제 버스 도착정보와 탑승 보장을 의미하지 않아요.'); render();
});
$('base-speed').addEventListener('input', () => {
  state.speedOrigin = 'manual';
  state.baseSpeed = Number($('base-speed').value) / 3.6;
  $('base-speed-value').textContent = `${Number($('base-speed').value).toFixed(1)} km/h`;
  render();
});

function estimate(now) {
  const stale = state.tracking && (!state.lastGoodFix || now - state.lastGoodFix > 15000);
  const unreliable = state.tracking && ['inaccurate','jump','too-fast'].includes(tracker.status);
  const speed = state.demo ? state.demoSpeed : state.tracking ? tracker.current : state.baseSpeed;
  const progress = state.route && state.position ? projectOnRoute(state.position,state.route.points,state.route.distance) : null;
  const offRoute = progress && progress.offset > 45;
  const arrived = progress && progress.remaining < 15 && distance(state.position,state.destination.point) < 25 && !stale && !unreliable;
  const seconds = progress && !stale && !unreliable && !offRoute ? arrived ? 0 : etaSeconds(progress.remaining,speed) : null;
  return {stale,unreliable,speed,progress,offRoute,arrived,seconds};
}
function render() {
  renderCalibration();
  const now = Date.now(), e = estimate(now);
  $('route-button').disabled = !state.position || !state.destination || state.routeBusy || state.demo;
  $('route-button').textContent = state.routeBusy ? '경로 찾는 중…' : state.route ? '도보 경로 다시 찾기' : '도보 경로 찾기';
  $('stops-button').disabled = state.stopBusy;
  $('stops-button').textContent = state.stopBusy ? '정류장 찾는 중…' : '주변 700m 정류장 찾기 ↗';
  const speedValid = Number.isFinite(e.speed) && !e.stale && !e.unreliable;
  $('walking-speed').textContent = speedValid ? `${(e.speed * 3.6).toFixed(1)} km/h` : '--';
  $('journey-pace-note').textContent = state.demo ? '가상 체험 · 실제 보행 기록이 아니에요' : state.speedOrigin === 'calibrated' ? `내 측정 평균 ${(state.baseSpeed * 3.6).toFixed(1)} km/h · GPS 추정치` : `${state.speedOrigin === 'manual' ? '직접 설정' : '기본'} 속도 ${(state.baseSpeed * 3.6).toFixed(1)} km/h · 실제 측정값이 아니에요`;
  $('speed-source').textContent = state.demo ? '가상 속도' : state.tracking ? e.stale ? '신호 대기' : e.unreliable ? '측정 보류' : tracker.current === null ? '측정 중' : 'GPS 측정' : state.speedOrigin === 'calibrated' ? '측정 평균' : state.speedOrigin === 'manual' ? '직접 설정' : '기본 속도';
  $('tracking-tag').innerHTML = `<i></i>${state.demo ? '가상 체험' : state.tracking ? e.stale ? 'GPS 대기' : '측정 중' : '설정 속도'}`;
  $('tracking-tag').classList.toggle('active',state.tracking && !e.stale);
  $('eta-label').textContent = state.demo ? '가상 경로 예상 도착까지' : '예상 도착까지';
  $('remaining-distance').textContent = e.progress ? shortDistance(e.progress.remaining) : state.position && state.destination ? shortDistance(distance(state.position,state.destination.point)) : '--';
  $('eta-minutes').textContent = e.arrived ? '도착' : e.seconds !== null ? String(Math.max(1,Math.ceil(e.seconds / 60))) : '--';
  $('eta-unit').textContent = e.arrived ? '부근' : '분';
  let note = '실제 도보 경로를 찾기 전에는 도착 시간을 표시하지 않아요.';
  let arrival = '목적지를 정하면 여기에 알려드릴게요';
  if (state.destination && !state.position) arrival = '출발지를 정하거나 위치 측정을 시작해 주세요';
  else if (state.destination && !state.route) { arrival = '도보 경로를 먼저 찾아 주세요'; note = '표시된 거리는 직선거리예요. 점선은 걸을 수 있는 길을 뜻하지 않아요.'; }
  if (state.route) {
    note = state.demo ? '가상 위치·속도·경로로 동작을 확인하는 체험이에요. 실제 길 안내가 아니에요.' : `FOSSGIS 도보 경로 · 신호 대기와 경사는 제외${state.route.endpointGap > 15 ? ` · 끝점 연결 최대 ${Math.round(state.route.endpointGap)}m는 직선 추정` : ''}`;
    if (e.offRoute) arrival = '경로에서 벗어났어요. 도보 경로를 다시 찾아 주세요';
    else if (e.stale) arrival = '새 GPS 신호를 기다리고 있어요';
    else if (e.unreliable) arrival = '위치 또는 속도가 불확실해 ETA를 보류했어요';
    else if (e.arrived) arrival = '목적지와 가까워요. 실제 입구를 확인해 주세요';
    else if (e.speed !== null && e.speed < .25) arrival = '잠시 멈춰 있어요. 걸으면 다시 계산할게요';
    else if (e.seconds === null) arrival = '조금 걸어 주세요. 내 속도를 측정 중이에요';
    else arrival = `${formatTime(now + e.seconds * 1000)} 도착 예상${state.tracking || state.demo ? '' : ' · 설정 속도 기준'}`;
  }
  $('eta-arrival').textContent = arrival; $('estimate-note').textContent = note;
  const result = $('bus-result'); result.classList.toggle('hidden',!state.busArrival);
  if (state.busArrival) {
    const status = catchStatus(state.busArrival,e.seconds,now), remaining = Math.max(0,Math.ceil((state.busArrival - now) / 60000));
    const headline = status.kind === 'expired' ? '입력한 도착 시간이 지났어요. 새 시간을 확인해 주세요.' : status.kind === 'unknown' ? '도보 ETA가 확인되면 비교할 수 있어요.' : status.kind === 'possible' ? `1분 여유를 포함해 약 ${Math.floor(status.margin / 60)}분 남아요.` : '시간이 빠듯해요. 다음 버스도 확인해 보세요.';
    let copy = result.querySelector('span');
    if (!copy) {
      copy = document.createElement('span'); result.append(copy);
      const clear = document.createElement('button'); clear.textContent = '입력 시간 지우기'; clear.addEventListener('click',() => { state.busArrival = null; render(); }); result.append(clear);
    }
    copy.textContent = `${state.demo ? '[가상 보행 체험] ' : ''}[직접 입력 · 실시간 아님] ${remaining}분 후 도착. ${headline} 목적지가 탑승 정류장인지 확인해 주세요.`;
    result.classList.toggle('warn',status.kind !== 'possible');
  }
  meetingUI?.refresh();
}

const DEMO_POINTS = [[37.5665,126.9780],[37.5665,126.9792],[37.5672,126.9792],[37.5684,126.9794],[37.5685,126.9810],[37.5692,126.9812],[37.5700,126.9814],[37.5703,126.9827]];
function pointAlong(points, meters) {
  for (let i = 1; i < points.length; i++) {
    const length = distance(points[i - 1],points[i]);
    if (meters <= length) { const t = length ? meters / length : 0; return [points[i - 1][0] + (points[i][0] - points[i - 1][0]) * t,points[i - 1][1] + (points[i][1] - points[i - 1][1]) * t]; }
    meters -= length;
  }
  return points.at(-1);
}
function startDemo() {
  leaveOnboarding();
  clearRequests(); stopTracking(); tracker.reset(); state.demo = true; state.demoProgress = 0; state.busArrival = null;
  state.position = DEMO_POINTS[0]; state.start = state.position;
  state.destination = {point:DEMO_POINTS.at(-1),name:'가상 목적지 · 도보 체험',source:'가상 데이터'};
  state.route = {points:DEMO_POINTS,distance:pathDistance(DEMO_POINTS),source:'가상 체험'};
  $('destination-name').textContent = state.destination.name; $('destination-detail').textContent = '가상 위치와 경로 · 실제 길 안내가 아니에요';
  $('clear-destination').classList.remove('hidden'); $('demo-banner').classList.remove('hidden'); $('map-gate').classList.add('hidden');
  $('set-start').classList.add('hidden');
  $('map-caption').textContent = state.mapEnabled ? '지도 위 가상 경로 · 실제 보행로가 아니에요' : '온라인 지도 꺼짐 · 가상 경로만 표시 중';
  $('map-tip').textContent = '가상 이동에 따라 남은 시간과 거리가 바뀌어요';
  stopLayer.clearLayers(); $('stop-results').classList.add('hidden'); notice(); draw(); fitMap(); render();
}
function exitDemo() {
  state.demo = false; state.position = null; state.start = null; state.route = null; state.destination = null; state.busArrival = null;
  $('demo-banner').classList.add('hidden'); $('destination-name').textContent = '지도에서 목적지를 선택해 주세요';
  $('set-start').classList.remove('hidden');
  $('destination-detail').textContent = '장소 검색이나 좌표 입력도 가능해요'; $('clear-destination').classList.add('hidden');
  $('map-tip').textContent = '지도를 눌러 목적지를 정하세요';
  if (!state.mapEnabled) $('map-gate').classList.remove('hidden');
  $('map-caption').textContent = state.mapEnabled ? '초기 지도: 서울 시청 · 현재 위치가 아니에요' : '온라인 지도 꺼짐';
  draw(); render();
}
$('demo-button').addEventListener('click',startDemo); $('offline-demo').addEventListener('click',startDemo); $('exit-demo').addEventListener('click',exitDemo);
setInterval(() => {
  const now = Date.now(), delta = Math.min(2,(now - lastTick) / 1000); lastTick = now;
  if (state.demo && document.visibilityState === 'visible') {
    state.demoSpeed = 1.2 + .16 * Math.sin(now / 20000);
    state.demoProgress = Math.min(state.route.distance,state.demoProgress + delta * state.demoSpeed);
    state.position = pointAlong(DEMO_POINTS,state.demoProgress); draw();
  }
  render();
},1000);
render();

meetingUI = initMeetupUI({map,askConsent,notice,formatTime,
  getContext:() => ({...state,estimate:estimate(Date.now()),fix:tracker.lastFix}),
  requestGps:startTracking,
  showSharedMap:() => { $('map-gate').classList.add('hidden'); if (!state.mapEnabled) $('map-caption').textContent = '온라인 지도 꺼짐 · 동의한 친구의 좌표만 표시해요'; },
  selectDestination:(point,name) => { if (state.demo) exitDemo(); setDestination(point,name,'친구와의 약속 장소'); fitMap(); }
});

if ('serviceWorker' in navigator && window.isSecureContext) navigator.serviceWorker.register('./sw.js').catch(() => {});
