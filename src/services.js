import {isCoordinate, distance, projectOnRoute} from './core.js';

export const SERVICES = Object.freeze({
  tiles: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
  search: 'https://nominatim.openstreetmap.org/search',
  walking: 'https://routing.openstreetmap.de/routed-foot/route/v1/foot/',
  stops: 'https://overpass-api.de/api/interpreter'
});

async function getJson(url, signal, timeoutMs = 18000) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (signal?.aborted) controller.abort();
  signal?.addEventListener('abort', abort, {once: true});
  const timeout = setTimeout(abort, timeoutMs);
  try {
    const response = await fetch(url, {signal: controller.signal, credentials: 'omit', referrerPolicy: 'strict-origin-when-cross-origin'});
    if (!response.ok) throw new Error(`서비스 응답 오류 (${response.status})`);
    return await response.json();
  } finally {
    clearTimeout(timeout); signal?.removeEventListener('abort', abort);
  }
}

export async function getNearbyStops(position, signal) {
  if (!isCoordinate(position)) throw new Error('출발지를 먼저 정해 주세요.');
  const [lat, lon] = position.map(n => n.toFixed(6));
  const query = `[out:json][timeout:15];(node[highway=bus_stop](around:700,${lat},${lon});node[public_transport=platform][bus=yes](around:700,${lat},${lon}););out body 40;`;
  const url = new URL(SERVICES.stops);
  url.searchParams.set('data', query);
  const data = await getJson(url, signal, 22000);
  if (!Array.isArray(data?.elements)) throw new Error('정류장 정보를 읽지 못했어요.');
  return data.elements.filter(item => item && typeof item === 'object').map(item => ({id: item.id, name: String(item.tags?.['name:ko'] || item.tags?.name || '이름 없는 정류장'), point: [item.lat, item.lon]})).filter(item => isCoordinate(item.point));
}

export async function getWalkingRoutes(start, end, signal) {
  if (!isCoordinate(start) || !isCoordinate(end)) throw new Error('올바른 출발지와 목적지가 필요해요.');
  const coordinates = [start, end].map(([lat, lon]) => `${lon.toFixed(6)},${lat.toFixed(6)}`).join(';');
  // FOSSGIS routed-foot is a separately prepared walking profile, not driving.
  const url = `${SERVICES.walking}${coordinates}?overview=full&geometries=geojson&steps=true&alternatives=true`;
  const data = await getJson(url, signal);
  if (data?.code !== 'Ok' || !Array.isArray(data.routes)) throw new Error('이 목적지까지의 도보 경로를 찾지 못했어요.');
  const waypoints = Array.isArray(data.waypoints) ? data.waypoints : [];
  if (waypoints.some(point => point?.distance !== undefined && (!Number.isFinite(point.distance) || point.distance < 0))) throw new Error('도보 경로의 위치 오차 정보를 읽지 못했어요.');
  const snapDistance = Math.max(...waypoints.map(point => point?.distance ?? 0), 0);
  if (snapDistance > 100) throw new Error('선택한 지점에서 100m 이내의 보행 경로를 찾지 못했어요. 다른 지점을 선택해 주세요.');
  const seen = new Set(), routes = [];
  for (const route of data.routes.slice(0,3)) {
    const geometry = route?.geometry?.coordinates;
    const points = Array.isArray(geometry) ? geometry.map(point => Array.isArray(point) ? [point[1],point[0]] : null) : null;
    if (!points || points.length < 2 || !points.every(isCoordinate) || !Number.isFinite(route.distance) || route.distance <= 0) continue;
    const key = JSON.stringify(points); if (seen.has(key)) continue; seen.add(key);
    let along = 0;
    const rawSteps = route.legs?.flatMap(leg => Array.isArray(leg.steps) ? leg.steps : []) || [];
    const steps = [];
    for (const step of rawSteps) {
      if (!Number.isFinite(step.distance) || step.distance < 0) { steps.length = 0; break; }
      const m = step.maneuver;
      if (!m || !isCoordinate([m.location?.[1],m.location?.[0]])) { steps.length = 0; break; }
      steps.push({at:along,type:String(m.type || ''),modifier:String(m.modifier || ''),name:String(step.name || '').slice(0,120)});
      along += step.distance;
    }
    // Do not use incomplete maneuver distances for navigation.
    if (Math.abs(along-route.distance) > Math.max(20,route.distance*.02)) steps.length=0;
    routes.push({steps, points, distance: route.distance, source: 'FOSSGIS 도보 경로', snapDistance});
  }
  if (!routes.length) throw new Error('이 목적지까지의 도보 경로를 찾지 못했어요.');
  return routes;
}
export async function getWalkingRoute(start, end, signal) { return (await getWalkingRoutes(start,end,signal))[0]; }

export async function getRouteLamps(routes, signal) {
  const points = routes.flatMap(route => route.points || []);
  if (!points.length || points.length > 15000 || !points.every(isCoordinate)) throw new Error('먼저 실제 도보 경로를 찾아 주세요.');
  const south = Math.min(...points.map(p=>p[0])) - .0003, north = Math.max(...points.map(p=>p[0])) + .0003;
  const west = Math.min(...points.map(p=>p[1])) - .0004, east = Math.max(...points.map(p=>p[1])) + .0004;
  if (distance([south,west],[north,east]) > 5000) throw new Error('가로등 조회는 주변 5km 이내 범위에서만 지원해요.');
  const url = new URL(SERVICES.stops);
  url.searchParams.set('data', `[out:json][timeout:15];node[highway=street_lamp](${south.toFixed(6)},${west.toFixed(6)},${north.toFixed(6)},${east.toFixed(6)});out body 1201;`);
  const data = await getJson(url, signal, 22000);
  if (!Array.isArray(data?.elements) || data.remark || data.elements.length > 1200) throw new Error('가로등 데이터를 완전하게 받지 못했어요. 비교하지 않아요.');
  const lamps = [], seen = new Set();
  for (const item of data.elements) {
    if (!item || item.tags?.highway !== 'street_lamp' || !Number.isFinite(item.id) || seen.has(item.id) || !isCoordinate([item.lat,item.lon])) continue;
    seen.add(item.id);lamps.push({id:item.id,point:[item.lat,item.lon]});
  }
  return routes.map(route => lamps.filter(lamp => projectOnRoute(lamp.point,route.points,route.distance)?.offset <= 20));
}

let lastSearch = 0;
const searchCache = new Map();
export async function searchPlaces(query, signal) {
  const clean = query.trim();
  if (clean.length < 2 || clean.length > 180) throw new Error('장소 이름을 2~180자로 입력해 주세요.');
  if (searchCache.has(clean)) return searchCache.get(clean);
  if (Date.now() - lastSearch < 1100) throw new Error('잠시 후 다시 검색해 주세요.');
  lastSearch = Date.now();
  const url = new URL(SERVICES.search);
  url.search = new URLSearchParams({q: clean, format: 'jsonv2', limit: '5', 'accept-language': 'ko'}).toString();
  const data = await getJson(url, signal);
  if (!Array.isArray(data)) throw new Error('장소 검색 결과를 읽지 못했어요.');
  const numeric = value => (typeof value === 'number' || typeof value === 'string') && String(value).trim() !== '' && Number.isFinite(Number(value));
  const results = data.filter(item => item && numeric(item.lat) && numeric(item.lon)).map(item => ({name: String(item.display_name || '검색한 장소'), point: [Number(item.lat), Number(item.lon)]})).filter(item => isCoordinate(item.point));
  searchCache.set(clean, results);
  return results;
}

