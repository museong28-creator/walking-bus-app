const ID_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;
export class SharingError extends Error {
  constructor(message,status = 0,code = '') { super(message); this.name = 'SharingError'; this.status = status; this.code = code; }
}
export function normalizeServerUrl(value,{allowLocalhost = false} = {}) {
  let url; try { url = new URL(value); } catch { throw new Error('공유 서버의 HTTPS 주소를 입력해 주세요.'); }
  const local = ['localhost','127.0.0.1','[::1]'].includes(url.hostname);
  if (url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) throw new Error('서버 주소에는 경로, 계정, 쿼리 또는 초대 토큰을 넣지 마세요.');
  if (url.protocol !== 'https:' && !(allowLocalhost && local && url.protocol === 'http:')) throw new Error('공유는 HTTPS 서버에서만 가능해요. HTTP localhost는 개발용으로만 허용돼요.');
  if (local && !allowLocalhost) throw new Error('배포된 페이지에서는 공개 HTTPS 공유 서버를 사용해 주세요.');
  return url.origin;
}
export function makeInviteUrl(pageUrl,serverUrl,roomId,inviteToken) {
  if (!ID_PATTERN.test(roomId) || !ID_PATTERN.test(inviteToken)) throw new Error('초대 정보가 올바르지 않아요.');
  const url = new URL(pageUrl); url.search = '';
  url.hash = new URLSearchParams({meeting:'1',server:serverUrl,room:roomId,invite:inviteToken}).toString();
  return url.href;
}
export function parseInvite(value,options = {}) {
  const hash = value.startsWith('#') ? value.slice(1) : new URL(value).hash.slice(1);
  const params = new URLSearchParams(hash);
  if (params.get('meeting') !== '1' || !ID_PATTERN.test(params.get('room') || '') || !ID_PATTERN.test(params.get('invite') || '')) throw new Error('올바른 약속 초대 링크가 아니에요.');
  return {serverUrl:normalizeServerUrl(params.get('server'),options),roomId:params.get('room'),inviteToken:params.get('invite')};
}

export class MeetingClient {
  constructor(serverUrl,{fetchImpl = globalThis.fetch,allowLocalhost = false} = {}) {
    this.serverUrl = normalizeServerUrl(serverUrl,{allowLocalhost}); this.fetch = fetchImpl;
    this.session = null; this.sharing = false; this.shareEpoch = null; this.sequence = 0;
    this.generation = 0; this.startPending = false; this.stopping = false; this.stopRequests = 0; this.entryPending = false;
  }
  async request(path,body,token,{keepalive = false} = {}) {
    const controller = new AbortController(), timeout = setTimeout(() => controller.abort(),12000);
    try {
      const response = await this.fetch(`${this.serverUrl}/api/rooms/${path}`,{
        method:'POST',headers:{'Content-Type':'application/json',...(token ? {Authorization:`Bearer ${token}`} : {})},
        credentials:'omit',cache:'no-store',redirect:'error',referrerPolicy:'no-referrer',
        body:JSON.stringify(body),signal:controller.signal,keepalive
      });
      let data; try { data = await response.json(); } catch { throw new SharingError('공유 서버 응답을 읽지 못했어요.',response.status); }
      if (!response.ok) throw new SharingError(data?.error?.message || '공유 요청을 완료하지 못했어요.',response.status,data?.error?.code);
      return data;
    } finally { clearTimeout(timeout); }
  }
  credentials(session = this.session) {
    if (!session) throw new Error('약속방에 먼저 들어가 주세요.');
    return {roomId:session.roomId,memberId:session.memberId};
  }
  setSession(data) {
    if (!data || !ID_PATTERN.test(data.roomId) || !ID_PATTERN.test(data.memberId) || !ID_PATTERN.test(data.memberToken)) throw new Error('공유 서버가 올바른 참여 정보를 주지 않았어요.');
    this.session = data; return data;
  }
  async create({displayName,destination,meetingAt}) {
    return this.enter('create',{displayName,destination,meetingAt});
  }
  async join({roomId,inviteToken,displayName}) {
    return this.enter('join',{roomId,displayName},inviteToken);
  }
  async enter(path,body,token) {
    if (this.session || this.entryPending) throw new Error('현재 약속방 또는 참여 요청을 마무리한 후 다시 진행해 주세요.');
    this.entryPending = true; const generation = ++this.generation;
    try {
      const data = await this.request(path,body,token);
      if (generation !== this.generation) {
        if (data?.roomId && data.memberId && data.memberToken) await this.request('leave',this.credentials(data),data.memberToken,{keepalive:true});
        return null;
      }
      return this.setSession(data);
    } finally { this.entryPending = false; }
  }
  async snapshot() { return this.request('snapshot',this.credentials(),this.session.memberToken); }
  async startSharing() {
    if (this.startPending || this.stopping) throw new Error('이전 공유 요청을 마무리하고 있어요. 잠시 후 다시 눌러 주세요.');
    const session = this.session, body = this.credentials(session), generation = ++this.generation;
    this.startPending = true;
    try {
      const result = await this.request('sharing/start',body,session.memberToken);
      if (generation !== this.generation || session !== this.session) {
        await this.request('sharing/stop',body,session.memberToken,{keepalive:true}); return false;
      }
      if (!ID_PATTERN.test(result?.shareEpoch)) throw new Error('위치 공유 세션을 확인하지 못했어요.');
      this.shareEpoch = result.shareEpoch; this.sequence = 0; this.sharing = true; return true;
    } finally { this.startPending = false; }
  }
  async publish(position) {
    if (!this.sharing || !this.shareEpoch) return false;
    const session = this.session, generation = this.generation;
    try {
      await this.request('position',{...this.credentials(session),shareEpoch:this.shareEpoch,sequence:++this.sequence,position},session.memberToken);
      return this.sharing && generation === this.generation;
    } catch (error) {
      if (generation === this.generation && [401,403,404,409,410].includes(error.status)) { this.sharing = false; this.shareEpoch = null; }
      throw error;
    }
  }
  async stopSharing({keepalive = false} = {}) {
    ++this.generation; this.sharing = false; this.shareEpoch = null;
    if (!this.session) return true;
    const session = this.session; this.stopRequests++; this.stopping = true;
    try { await this.request('sharing/stop',this.credentials(session),session.memberToken,{keepalive}); return true; }
    finally { this.stopRequests--; this.stopping = this.stopRequests > 0; }
  }
  async leave({closeRoom = false} = {}) {
    const session = this.session;
    ++this.generation; this.sharing = false; this.shareEpoch = null; this.session = null;
    if (!session) return;
    await this.request(closeRoom ? 'close' : 'leave',this.credentials(session),session.memberToken,{keepalive:true});
  }
}
