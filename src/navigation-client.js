// Inactive until a verified, authenticated navigation backend is configured.
// No provider keys belong in this browser module.
import {isCoordinate} from './core.js';
import {NAVIGATION_API_ORIGIN} from './firebase-config.js';
const id = v => typeof v === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(v);
const city = v => typeof v === 'string' && /^\d{1,9}$/.test(v);
const invalid = () => { throw new Error('정보를 확인하지 못했어요. 다시 조회해 주세요.'); };
export function arrivalIsFresh(data, now = Date.now()) {
  const fetched = Date.parse(data?.fetchedAt), expires = Date.parse(data?.expiresAt);
  return Number.isFinite(fetched) && Number.isFinite(expires) && fetched <= now + 5000 && expires > now && expires > fetched && expires - fetched <= 30000;
}
export function createNavigationClient({origin, fetchImpl = fetch, now = Date.now, timeoutMs = 12000, getIdToken} = {}) {
  const base = new URL(origin);
  if (base.origin !== origin || base.username || base.password || base.protocol !== 'https:') throw new Error('HTTPS 서버 주소가 필요해요.');
  async function request(path, input, signal) {
    const controller = new AbortController(), abort = () => controller.abort();
    if (signal?.aborted) abort();
    signal?.addEventListener('abort', abort, {once:true});
    const timer = setTimeout(abort, timeoutMs);
    try {
      if (controller.signal.aborted) throw new DOMException('Aborted','AbortError');
      const headers={'Content-Type':'application/json'};
      if(getIdToken){
        if(origin!==NAVIGATION_API_ORIGIN)throw new Error('인증 정보를 보낼 수 없는 서버예요.');
        let token;try{token=await getIdToken();}catch{throw new Error('Google 로그인이 필요해요.');}
        if(typeof token!=='string'||token.length>8192||!/^[A-Za-z0-9_.-]+$/.test(token))throw new Error('Google 로그인이 필요해요.');
        headers.Authorization=`Bearer ${token}`;
      }
      if(controller.signal.aborted)throw new DOMException('Aborted','AbortError');
      const response = await fetchImpl(`${origin}/v1/${path}`, {method:'POST',headers,body:JSON.stringify(input),signal:controller.signal,credentials:'same-origin',redirect:'error',cache:'no-store',referrerPolicy:'no-referrer'});
      if (!response.ok) {
        if (response.status === 401 || response.status === 403) throw new Error('서버 접근 권한을 확인해 주세요.');
        if (response.status === 429) throw new Error('조회 한도에 도달했어요. 잠시 후 다시 시도해 주세요.');
        if (response.status === 503) throw new Error('실시간 정보 연결을 준비 중이에요.');
        throw new Error('정보 제공기관에 연결하지 못했어요. 다시 시도해 주세요.');
      }
      const data = await response.json();
      if (controller.signal.aborted) throw new DOMException('Aborted','AbortError');
      return data;
    } finally {clearTimeout(timer);signal?.removeEventListener('abort',abort);}
  }
  return {
    async walking(start,end,signal,mode='SHORTEST') {
      if (!isCoordinate(start) || !isCoordinate(end) || !['SHORTEST','BROAD_FIRST','ACCESSIBLE'].includes(mode)) invalid();
      const data = await request('walk',{start,end,mode},signal);
      if (!Array.isArray(data?.points) || data.points.length < 2 || !data.points.every(isCoordinate) || !Number.isFinite(data.distance) || data.distance <= 0 || !Number.isFinite(data.snapDistance) || data.snapDistance < 0 || data.snapDistance > 100 || data.source !== 'Kakao 도보 경로') invalid();
      return data;
    },
    async stops(point,signal) {
      if (!isCoordinate(point)) invalid();
      const data = await request('stops',{point},signal);
      if (!Array.isArray(data?.stops) || data.stops.some(s => s.provider !== 'TAGO' || !id(s.id) || !city(s.cityCode) || !isCoordinate(s.point) || typeof s.name !== 'string')) invalid();
      return data;
    },
    async arrivals(cityCode,stopId,signal) {
      if (!city(cityCode) || !id(stopId)) invalid();
      const data = await request('arrivals',{cityCode,stopId},signal);
      if (data?.provider !== 'TAGO' || !['estimated','no_data'].includes(data.status) || !Array.isArray(data.arrivals) || data.arrivals.some(a => !id(a.routeId) || typeof a.routeName !== 'string' || !Number.isFinite(a.etaSeconds) || a.etaSeconds < 0) || (data.status === 'no_data') !== (data.arrivals.length === 0)) invalid();
      if (!arrivalIsFresh(data,now())) throw new Error('도착 정보가 오래됐어요. 다시 조회해 주세요.');
      return data;
    },
    async cities(signal) {
      const data = await request('cities',{},signal);
      if (!Array.isArray(data?.cities) || data.cities.some(c => !city(c.code) || typeof c.name !== 'string')) invalid();
      return data;
    }
  };
}

export function createAuthenticatedNavigationClient(session){
  return createNavigationClient({origin:NAVIGATION_API_ORIGIN,getIdToken:()=>session.getIdToken()});
}
