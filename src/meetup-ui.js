import {assessDeadline,positionFreshness,localDateTimeValue} from './meeting.js';
import {MeetingClient,parseInvite,makeInviteUrl} from './sharing.js';
import {isCoordinate,distance} from './core.js';

export function initMeetupUI({map,askConsent,notice,formatTime,getContext,requestGps,selectDestination,showSharedMap}) {
  const $ = id => document.getElementById(id);
  const local = ['localhost','127.0.0.1','[::1]'].includes(location.hostname);
  const friendLayer = L.layerGroup().addTo(map);
  let targetTime = null, bufferSeconds = 120, comfortSpeedMps = 4.3 / 3.6;
  let client = null, room = null, invitation = null, roomBusy = false, shareBusy = false;
  let lastPoll = 0, polling = false, lastPublish = 0, publishing = false, lastSentFix = 0;
  let serverOffset = 0, lastRenderKey = '';
  const status = text => { $('sharing-status').textContent = text; };
  $('target-time').value = localDateTimeValue(Date.now() + 30 * 60000);
  $('time-zone-label').textContent = `기기 시간대: ${Intl.DateTimeFormat().resolvedOptions().timeZone}`;

  function showPlan() {
    const context = getContext(), e = context.estimate;
    $('deadline-result').classList.toggle('hidden',targetTime === null);
    if (targetTime === null) return;
    const remaining = e.progress && !e.stale && !e.unreliable && !e.offRoute ? e.arrived ? 0 : e.progress.remaining : null;
    const outcome = assessDeadline({remainingMeters:remaining,targetTime,now:Date.now(),bufferSeconds,
      currentSpeedMps:e.stale || e.unreliable ? null : e.speed,comfortSpeedMps});
    const labels = {arrived:'목적지 근처에 도착했어요',expired:'설정한 시간이 지났어요',late:'현재 걸음으로는 시간이 빠듯해요',
      uncomfortable:'편한 걸음으로는 여유가 부족해요',tight:'예상 여유가 1분보다 적어요',comfortable:'현재 기준으로 여유가 있어요',unknown:'경로와 속도를 확인하고 있어요'};
    $('deadline-headline').textContent = `${context.demo ? '[가상 체험] ' : ''}${labels[outcome.kind]}`;
    let detail = `${formatTime(targetTime)} 도착 목표 · ${bufferSeconds / 60}분 먼저 도착하는 기준이에요.`;
    if (remaining === null) detail = '실제 도보 경로와 믿을 수 있는 현재 위치가 필요해요. 직선거리로 필요한 속도를 계산하지 않아요.';
    else if (['expired','late','uncomfortable'].includes(outcome.kind)) detail += ' 무리하지 말고 약속 시간을 조정하거나 다음 버스를 확인해 주세요.';
    else if (outcome.marginSeconds !== null && outcome.marginSeconds >= 0) detail += ` 여유 시간 외에 약 ${Math.floor(outcome.marginSeconds / 60)}분이 남아요.`;
    $('deadline-detail').textContent = detail;
    const canShowPace = outcome.requiredSpeedMps > 0 && outcome.requiredSpeedMps <= Math.min(comfortSpeedMps,1.67);
    if (canShowPace) {
      const seconds = Math.floor(outcome.requiredPaceSecondsPerKm);
      $('deadline-pace').textContent = `계산상 필요한 평균 ${(outcome.requiredSpeedMps * 3.6).toFixed(1)} km/h (약 ${Math.floor(seconds / 60)}분 ${String(seconds % 60).padStart(2,'0')}초/km). 속도를 높이라는 안내가 아니에요.`;
    } else $('deadline-pace').textContent = outcome.kind === 'uncomfortable' ? '필요한 속도가 내 편한 속도 상한을 넘어요. 더 빠르게 걷도록 권하지 않아요.' : '신호 대기와 경사는 반영하지 않은 추정이에요.';
    $('deadline-result').classList.toggle('warn',!['comfortable','arrived'].includes(outcome.kind));
  }
  $('deadline-form').addEventListener('submit',event => {
    event.preventDefault(); const value = new Date($('target-time').value).getTime();
    if (!Number.isFinite(value)) { notice('도착하고 싶은 날짜와 시간을 정해 주세요.'); return; }
    targetTime = value; bufferSeconds = Number($('arrival-buffer').value); comfortSpeedMps = Number($('comfort-speed').value) / 3.6;
    notice(room ? '내 시간 비교를 바꿨어요. 이미 만든 약속방의 시간은 바뀌지 않아요.' : '정한 시간과 내 편한 걸음으로 도착할 수 있을지 비교해요.'); showPlan();
  });
  $('clear-deadline').addEventListener('click',() => { targetTime = null; showPlan(); });
  function syncControls() {
    const active = Boolean(client?.session);
    $('room-setup').classList.toggle('hidden',active); $('room-active').classList.toggle('hidden',!active);
    $('create-room').disabled = roomBusy; $('join-room').disabled = roomBusy;
    $('share-location').disabled = shareBusy || Boolean(client?.startPending || client?.stopping);
    const sharing = Boolean(client?.sharing || client?.startPending);
    $('share-location').classList.toggle('hidden',sharing); $('stop-sharing').classList.toggle('hidden',!sharing);
    $('sharing-badge').textContent = active ? sharing ? '내 위치 공유 중' : '약속방 연결됨' : '서버 설정 필요';
    const host = room && client?.session?.memberId === room.hostMemberId;
    $('close-room').classList.toggle('hidden',!host); $('leave-room').textContent = host ? '나가기 (모두 종료)' : '약속방 나가기';
    $('invite-controls').classList.toggle('hidden',!invitation || !active);
  }
  function validRoom(data,current) {
    return data && data.roomId === current.session?.roomId && isCoordinate(data.destination?.point)
      && typeof data.destination.name === 'string' && Array.isArray(data.members) && data.members.length <= 8
      && Number.isFinite(data.serverTime) && Number.isFinite(data.expiresAt);
  }
  async function pollRoom(force = false) {
    if (!client?.session || polling || document.visibilityState !== 'visible' || (!force && Date.now() - lastPoll < 5000)) return;
    const current = client; lastPoll = Date.now(); polling = true;
    try {
      const data = await current.snapshot();
      if (current !== client || !current.session) return;
      if (!validRoom(data,current)) throw new Error('약속방 정보가 올바르지 않아요.');
      room = data; serverOffset = data.serverTime - Date.now();
      $('room-destination').textContent = room.destination.name;
      $('room-time').textContent = Number.isFinite(room.meetingAt) ? `약속 ${new Intl.DateTimeFormat('ko-KR',{month:'numeric',day:'numeric',hour:'numeric',minute:'2-digit'}).format(room.meetingAt)}` : '약속 시간 미설정';
      $('room-expiry').textContent = `${new Intl.DateTimeFormat('ko-KR',{month:'numeric',day:'numeric',hour:'numeric',minute:'2-digit'}).format(room.expiresAt)} 방 만료 · 초대받은 최대 8명${room.meetingAt >= room.expiresAt ? ' · 주의: 약속보다 방이 먼저 만료돼요. 가까운 시간에 새 방을 만들어 주세요.' : ''}`;
      renderFriends(); syncControls();
    } catch (error) {
      if (current !== client) return;
      if ([401,403,404,410].includes(error.status)) {
        current.generation++; current.sharing = false; current.shareEpoch = null; current.session = null;
        room = null; invitation = null; friendLayer.clearLayers();
        notice('약속방이 만료·종료되었거나 접근할 수 없어요. 위치 공유를 중지했어요.'); syncControls();
      } else status('서버 연결이 지연되고 있어요. 아래 위치의 갱신 시각을 확인해 주세요. 오래된 위치는 자동으로 숨겨요.');
    } finally { polling = false; }
  }
  async function enterRoom(joining) {
    if (roomBusy || client?.session) return;
    const name = $('friend-name').value.trim(), context = getContext();
    if (!name || name.length > 24) { notice('친구들에게 보여 줄 이름을 1~24자로 입력해 주세요.'); return; }
    if (!joining && (context.demo || !context.destination)) { notice('체험을 종료하고 실제 약속 장소를 지도에서 선택해 주세요.'); return; }
    let invite, next;
    try {
      if (joining) invite = parseInvite($('invite-input').value.trim(),{allowLocalhost:local});
      next = new MeetingClient(invite?.serverUrl || $('sharing-server').value.trim(),{allowLocalhost:local});
    } catch (error) { notice(error.message); return; }
    const body = joining ? `공유 서버 ${next.serverUrl}로 표시 이름 “${name}”을 보내 초대방에 참여해요. 이름은 이 방의 참가자에게 보이고, 초대 링크를 가진 사람이 들어올 수 있어요. 내 위치는 아직 보내지 않아요.`
      : `공유 서버 ${next.serverUrl}로 표시 이름 “${name}”, 선택한 목적지의 이름·정확한 좌표${targetTime ? '와 약속 시간' : ''}를 보내 약속방을 만들어요. 이 정보는 초대 링크로 들어온 참가자에게 보여요. 내 현재 위치는 아직 보내지 않아요.`;
    if (!(await askConsent(joining ? '초대받은 약속방 참여' : '친구와 약속 만들기',body,'표시 이름은 본인 인증이 아니에요. 신뢰하는 서버와 친구에게만 정보를 공유하세요.'))) return;
    roomBusy = true; syncControls(); client = next;
    try {
      const session = joining ? await client.join({...invite,displayName:name})
        : await client.create({displayName:name,destination:context.destination,meetingAt:targetTime});
      if (!session || client !== next) return;
      invitation = joining ? invite : {serverUrl:next.serverUrl,roomId:session.roomId,inviteToken:session.inviteToken};
      await pollRoom(true);
      if (room) {
        selectDestination(room.destination.point,room.destination.name);
        if (Number.isFinite(room.meetingAt)) { targetTime = room.meetingAt; $('target-time').value = localDateTimeValue(targetTime); }
        showSharedMap?.();
      }
      if (location.hash.includes('meeting=1')) history.replaceState(null,'',location.pathname + location.search);
      $('invite-input').value = ''; $('sharing-server').value = next.serverUrl;
      status('약속방에 들어왔어요. 내 위치는 공유하지 않아요. 공유 시작 버튼을 누를 때만 보내요.');
      notice();
    } catch (error) { notice(`약속방에 연결하지 못했어요. ${error.message}`); }
    finally { roomBusy = false; syncControls(); showPlan(); }
  }
  $('create-room').addEventListener('click',() => enterRoom(false));
  $('join-room').addEventListener('click',() => enterRoom(true));
  $('copy-invite').addEventListener('click',async () => {
    if (!client?.session || !invitation) return;
    const url = makeInviteUrl(location.href,client.serverUrl,invitation.roomId,invitation.inviteToken);
    try { await navigator.clipboard.writeText(url); status('초대 링크를 복사했어요. 신뢰하는 친구에게 직접 보내 주세요. 링크를 받은 사람은 방에 참여할 수 있어요.'); }
    catch { $('invite-output').value = url; $('invite-output').classList.remove('hidden'); status('자동 복사가 되지 않았어요. 표시된 링크를 길게 눌러 직접 복사해 주세요.'); }
  });
  async function beginSharing() {
    if (!client?.session || !room || shareBusy) return;
    const context = getContext();
    if (context.demo) { notice('가상 위치는 친구에게 보내지 않아요. 체험을 종료해 주세요.'); return; }
    if (!context.destination || distance(context.destination.point,room.destination.point) > 2) { selectDestination(room.destination.point,room.destination.name); }
    const current = client;
    if (!(await askConsent('내 위치를 이 약속방에 공유',`정확한 GPS 위치, 측정 시각·오차, 보행 속도와 이 약속 장소까지의 예상 시간을 ${client.serverUrl} 서버와 이 방의 모든 참가자에게 약 5초 간격으로 보내요. 초대 링크를 받은 사람이 추가로 참여할 수 있어요. 화면을 켜 둔 동안만 전송하며 언제든 중지할 수 있어요.`, '마지막 위치만 임시 보관해요. 중지 시 삭제를 요청하고, 통신 실패 시 마지막 위치는 최대 90초 후 숨김·삭제돼요. 이미 본 정보나 캡처는 회수할 수 없어요.'))) return;
    if (current !== client || !current.session || document.visibilityState !== 'visible') return;
    shareBusy = true; syncControls();
    try {
      if (await current.startSharing()) {
        lastSentFix = 0; lastPublish = 0;
        status('공유를 시작했어요. 정확한 GPS 위치를 기다리는 중이에요.');
        if (!getContext().tracking) requestGps();
      }
    } catch (error) { status(`위치 공유를 시작하지 못했어요. ${error.message}`); }
    finally { shareBusy = false; syncControls(); }
  }
  async function pauseSharing(reason = '내 위치 공유를 중지했어요.') {
    const current = client;
    if (!current?.session || (!current.sharing && !current.startPending)) return;
    const stopping = current.stopSharing({keepalive:true});
    status('이 기기의 새 위치 전송을 멈췄어요. 서버에 마지막 위치 삭제를 요청하고 있어요.'); syncControls();
    try { await stopping; if (client === current) status(`${reason} 서버의 마지막 위치 삭제를 확인했어요.`); }
    catch { if (client === current) status(`${reason} 새 전송은 중지했지만 서버 삭제는 확인하지 못했어요. 마지막 위치는 최대 90초 후 자동으로 숨겨져요.`); }
    finally { syncControls(); if (document.visibilityState === 'visible') pollRoom(true); }
  }
  $('share-location').addEventListener('click',beginSharing);
  $('stop-sharing').addEventListener('click',() => pauseSharing());
  async function leaveRoom(closeRoom = false) {
    if (!client?.session) return;
    const current = client, isHost = room?.hostMemberId === current.session.memberId;
    if (!(await askConsent(closeRoom || isHost ? '모두의 약속방을 종료할까요?' : '약속방에서 나갈까요?',closeRoom || isHost ? '방장이 나가면 이 약속방과 모든 참가자의 임시 위치가 삭제돼요. 초대 링크도 더 이상 사용할 수 없어요.' : '내 위치 전송을 중지하고 이 방의 이름과 마지막 위치 삭제를 요청해요.','이미 다른 사람이 본 정보나 캡처는 회수할 수 없어요.'))) return;
    try { await current.leave({closeRoom:closeRoom || isHost}); notice('약속방에서 나왔어요.'); }
    catch { notice('이 기기의 공유는 중지했지만 서버 삭제는 확인하지 못했어요. 마지막 위치는 최대 90초 후 숨겨지고 방 정보는 만료 때 삭제돼요.'); }
    if (client === current) { client = null; room = null; invitation = null; friendLayer.clearLayers(); $('friends-list').replaceChildren(); lastRenderKey = ''; }
    syncControls();
  }
  $('leave-room').addEventListener('click',() => leaveRoom(false)); $('close-room').addEventListener('click',() => leaveRoom(true));
  function visibleMembers() {
    return (room?.members || []).filter(member => member && typeof member.id === 'string').map(member => {
      const p = member.position;
      const freshness = member.sharing && isCoordinate(p?.point) ? positionFreshness(p,Date.now() + serverOffset) : 'hidden';
      return {...member,freshness};
    });
  }
  function renderFriends() {
    if (!room || !client?.session) return;
    const members = visibleMembers(), context = getContext();
    const key = JSON.stringify(members.map(m => [m.id,m.name,m.freshness,m.position,Math.floor((Date.now() + serverOffset - (m.position?.receivedAt || 0)) / 1000)])) + context.demo;
    if (key === lastRenderKey) return; lastRenderKey = key;
    $('friends-list').replaceChildren(); friendLayer.clearLayers();
    for (const member of members) {
      const self = member.id === client.session.memberId;
      const li = document.createElement('li'), dot = document.createElement('span'), copy = document.createElement('div'), name = document.createElement('strong'), detail = document.createElement('span'), timestamp = document.createElement('small');
      dot.className = 'friend-dot'; dot.textContent = self ? '나' : '친'; copy.className = 'friend-copy'; name.textContent = `${String(member.name || '참가자')}${self ? ' (나)' : ''}`;
      if (member.freshness === 'hidden') detail.textContent = member.sharing ? '신뢰할 수 있는 새 위치를 기다리고 있어요' : '위치 공유 꺼짐';
      else {
        const age = Math.max(0,Math.floor((Date.now() + serverOffset - member.position.receivedAt) / 1000));
        detail.textContent = member.freshness === 'stale' ? '오래된 위치 · 현재 위치가 아닐 수 있어요' : Number.isFinite(member.position.etaSeconds) ? `갱신 시점의 도보 ETA 약 ${Math.max(1,Math.ceil(member.position.etaSeconds / 60))}분` : '위치 공유 중 · 경로/속도 미측정';
        if (member.freshness === 'stale') detail.className = 'stale-label';
        timestamp.textContent = `${formatTime(member.position.receivedAt - serverOffset)} 갱신 · ${age}초 전 · 오차 약 ${Math.round(member.position.accuracy)}m`;
        if (!self && !context.demo) {
          const icon = L.divIcon({className:`point-marker ${member.freshness === 'stale' ? 'friend-stale' : 'friend'}`,html:'<div></div>',iconSize:[22,22],iconAnchor:[11,11]});
          const popup = document.createElement('span'); popup.textContent = `${name.textContent} · ${detail.textContent} · ${timestamp.textContent}`;
          L.marker(member.position.point,{icon,alt:`${name.textContent}의 동의한 공유 위치`}).bindPopup(popup).addTo(friendLayer);
        }
      }
      copy.append(name,detail,timestamp); li.append(dot,copy); $('friends-list').append(li);
    }
  }
  $('fit-friends').addEventListener('click',() => {
    if (getContext().demo) { notice('가상 체험을 종료하면 친구의 실제 공유 위치를 지도에 볼 수 있어요.'); return; }
    const points = visibleMembers().filter(m => m.freshness !== 'hidden').map(m => m.position.point);
    if (!points.length) { status('아직 공유된 위치가 없어요. 각자 공유 시작을 눌러야 지도에 표시돼요.'); return; }
    if (room?.destination) points.push(room.destination.point); showSharedMap?.();
    map.fitBounds(L.latLngBounds(points),{paddingTopLeft:[45,110],paddingBottomRight:[45,90],maxZoom:17});
  });
  function refresh() {
    showPlan(); renderFriends(); syncControls();
    if (!client?.session || document.visibilityState !== 'visible') return;
    pollRoom();
    const context = getContext(), e = context.estimate;
    if (!client.sharing || publishing || context.demo || !context.tracking || e.stale || e.unreliable || !context.fix) return;
    if (Date.now() - lastPublish < 5000 || context.lastGoodFix <= lastSentFix) return;
    if (!room || !context.destination || distance(context.destination.point,room.destination.point) > 2) { pauseSharing('목적지가 바뀌어 공유를 중지했어요.'); return; }
    const current = client; publishing = true; lastPublish = Date.now(); lastSentFix = context.lastGoodFix;
    current.publish({point:context.position,accuracy:context.fix.accuracy,speedMps:Number.isFinite(e.speed) ? e.speed : null,
      etaSeconds:Number.isFinite(e.seconds) ? e.seconds : null,recordedAt:context.lastGoodFix})
      .then(accepted => { if (accepted && current === client) status('내 실제 위치를 이 약속방에 공유 중이에요. 화면을 켜 두세요. 언제든 아래 버튼으로 중지할 수 있어요.'); })
      .catch(async error => { if (current === client) { await pauseSharing('연결 문제로 새 위치 공유를 멈췄어요.'); status(`공유 연결을 확인해 주세요. ${error.message} 새 위치를 보내려면 다시 공유 시작을 눌러 주세요.`); } })
      .finally(() => { publishing = false; syncControls(); });
  }
  function destinationChanged(point) {
    if (room && (!point || distance(point,room.destination.point) > 2)) pauseSharing('약속 장소와 다른 목적지를 선택해 위치 공유를 중지했어요.');
  }
  function useBusTime(timestamp) {
    targetTime = timestamp; bufferSeconds = 60;
    $('target-time').value = localDateTimeValue(timestamp); $('arrival-buffer').value = '60'; showPlan();
  }
  document.addEventListener('visibilitychange',() => { if (document.visibilityState !== 'visible') pauseSharing('화면 잠금·앱 전환으로 위치 공유를 중지했어요.'); });
  window.addEventListener('pagehide',() => {
    pauseSharing('페이지를 떠나 공유를 중지했어요.');
    if (client?.entryPending) client.leave().catch(() => {});
  });
  if (location.hash.includes('meeting=1')) {
    try {
      const invite = parseInvite(location.hash,{allowLocalhost:local});
      $('invite-input').value = location.href; $('sharing-server').value = invite.serverUrl;
      $('invite-input').closest('details').open = true;
      notice('친구의 초대 링크를 열었어요. 서버와 표시 이름을 확인하고 참여해 주세요. 아직 연결하거나 위치를 공유하지 않았어요.');
    } catch (error) { notice(error.message); }
  }
  syncControls(); showPlan();
  return {refresh,pauseSharing,destinationChanged,useBusTime};
}
