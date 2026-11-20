import {arrivalIsFresh, createAuthenticatedNavigationClient} from './navigation-client.js?v=pace-22';
import {distance} from './core.js?v=pace-20';

// Verified against TAGO getSttnNoList / getSttnThrghRouteList on 2026-11-20.
// Both directions of 894 visit this stop. TAGO arrival rows have no direction.
export const PILOT_STOP = Object.freeze({id:'DGB7121021100',cityCode:'22',name:'대구대(정문1)',number:'05633',point:Object.freeze([35.89710,128.84980]),routeId:'DGB3000894000',routeName:'894'});
export function pilotComparison(data, context, now=Date.now()) {
  const fresh=arrivalIsFresh(data,now);
  const elapsed=fresh?Math.max(0,(now-Date.parse(data.fetchedAt))/1000):0;
  const arrivals=fresh?data.arrivals.filter(a=>a.routeId===PILOT_STOP.routeId).map(a=>({...a,seconds:a.etaSeconds-elapsed})).filter(a=>a.seconds>=0).sort((a,b)=>a.seconds-b.seconds):[];
  const matches=!context.demo&&context.destination&&distance(context.destination.point,PILOT_STOP.point)<5;
  const seconds=matches&&context.route&&Number.isFinite(context.estimate?.seconds)?context.estimate.seconds:null;
  return {fresh,arrivals,walkSeconds:seconds,remaining:seconds!==null?context.estimate.progress.remaining:null,directionVerified:false};
}
const minutes=seconds=>seconds===0?'도착':seconds<60?'1분 미만':`${Math.ceil(seconds/60)}분`;
export function initBusPilot({document:doc=document,window:win=window,session,getContext,showStop,selectStop,navigation,now=Date.now}={}) {
  navigation??=createAuthenticatedNavigationClient(session);
  const $=id=>doc.getElementById(id);
  let data=null,controller=null,epoch=0,busy=false,message='도착정보 새로고침을 누르면 실제 TAGO 정보를 조회해요.';
  const cancel=()=>{epoch++;controller?.abort();controller=null;busy=false;data=null;};
  function render() {
    const context=getContext(),view=pilotComparison(data,context,now());
    $('pilot-refresh').disabled=busy||context.demo;
    $('pilot-refresh').textContent=busy?'무료 서버 연결 중…':'도착정보 새로고침';
    $('pilot-walk').disabled=context.demo;
    $('pilot-arrival').textContent=view.fresh?(view.arrivals[0]?minutes(view.arrivals[0].seconds):'도착정보 없음'):'—';
    $('pilot-arrival-detail').textContent=view.fresh?(view.arrivals[0]?`${view.arrivals[0].remainingStops??'?'}개 정류장 전${view.arrivals[1]?` / 다음 버스 ${minutes(view.arrivals[1].seconds)}`:''}`:'현재 894번 도착정보가 없어요. 운행 종료를 뜻하지는 않아요.'):data?'30초가 지나 숨겼어요. 다시 조회해 주세요.':'894번 / 방면 구분 없음';
    $('pilot-walk-time').textContent=view.walkSeconds===null?'—':minutes(view.walkSeconds);
    $('pilot-walk-detail').textContent=view.walkSeconds===null?(context.route&&context.estimate?.endpointUncertain?'보행로 끝점과 선택 위치가 20m 넘게 떨어져 있어 시간을 보류해요.':context.route&&(context.estimate?.stale||context.estimate?.unreliable||context.estimate?.offRoute)?'현재 위치를 다시 확인하거나 도보 경로를 다시 찾아 주세요.':'정류장을 목적지로 정하고 실제 도보 경로를 찾아 주세요.'):`${Math.round(view.remaining)}m 남음 / ${(context.estimate.speed*3.6).toFixed(1)}km/h ${context.tracking?'최근 보행 속도':context.speedOrigin==='default'?'기본 속도':'저장 속도'}`;
    $('pilot-status').textContent=context.demo?'체험에서는 실제 버스 조회와 비교를 하지 않아요.':message;
    $('pilot-updated').textContent=view.fresh?`조회 시각 ${new Date(data.fetchedAt).toLocaleTimeString('ko-KR')} / 30초 뒤 숨김`:'자동 조회 없음 / 버튼을 누를 때만 조회';
  }
  async function refresh() {
    if(busy||doc.visibilityState!=='visible'||getContext().demo)return;
    if(!session.user){message='상단 계정에서 Google 로그인 후 다시 눌러 주세요.';render();return;}
    const requestEpoch=++epoch;controller?.abort();controller=new AbortController();const active=controller;
    data=null;busy=true;message='공식 도착정보를 확인하고 있어요. 무료 서버가 쉬고 있으면 최대 65초 걸릴 수 있어요.';render();
    try{
      const result=await navigation.arrivals(PILOT_STOP.cityCode,PILOT_STOP.id,active.signal);
      if(requestEpoch!==epoch||active.signal.aborted||doc.visibilityState!=='visible')return;
      data=result;message='실제 TAGO 도착정보예요. 부기리 방면 여부는 버스 행선판에서 확인해 주세요.';
    }catch(error){
      if(requestEpoch!==epoch||active.signal.aborted)return;
      const messages={AUTH_REQUIRED:'계정에서 Google 로그인을 먼저 해 주세요.',ACCESS_DENIED:'이 계정은 서버 이용 권한이 없어요.',RATE_LIMITED:'무료 조회 한도에 도달했어요. 유료 전환 없이 조회를 멈췄어요.',UNAVAILABLE:'버스 정보 연결 설정을 확인해야 해요.'};
      message=messages[error?.code]||(error?.name==='AbortError'?'응답 시간이 초과됐어요. 잠시 후 다시 조회해 주세요.':'도착정보를 받지 못했어요. 잠시 후 다시 조회해 주세요.');
    }finally{if(requestEpoch===epoch){busy=false;render();}}
  }
  $('pilot-show').addEventListener('click',()=>showStop(PILOT_STOP));
  $('pilot-walk').addEventListener('click',()=>{if(!getContext().demo)selectStop(PILOT_STOP);});
  $('pilot-refresh').addEventListener('click',refresh);
  session.subscribe(()=>{cancel();message=session.user?'도착정보 새로고침으로 실제 버스를 확인하세요.':'상단 계정에서 Google 로그인 후 실제 도착정보를 조회할 수 있어요.';render();});
  doc.addEventListener('visibilitychange',()=>{if(doc.visibilityState!=='visible'){cancel();message='화면을 다시 열었어요. 도착정보를 새로 조회해 주세요.';}render();});
  win.addEventListener('pagehide',cancel);
  render();return {render};
}
