import {createAccountSession} from './firebase-session.js';
export function initAccountUI({document:doc=document,session=createAccountSession(),clipboard=globalThis.navigator?.clipboard}={}){
  const $=id=>doc.getElementById(id),dialog=$('account-dialog');let busy=false;
  const status=message=>{$('account-status').textContent=message;};
  const render=()=>{
    const user=session.user;
    $('account-button').textContent=user?'내 계정':'계정';
    $('account-prepare').hidden=session.ready||!!user;
    $('account-login').hidden=!session.ready||!!user;
    $('account-logout').hidden=!user;$('account-identity').hidden=!user;
    $('account-name').textContent=user?(user.displayName||'Google 계정'):'';
    $('account-uid').value=user?.uid||'';
    for(const id of ['account-prepare','account-login','account-logout','account-copy'])$(id).disabled=busy;
  };
  const errors=error=>{
    if(['auth/popup-closed-by-user','auth/cancelled-popup-request'].includes(error?.code))return '로그인을 취소했어요. 다시 시도할 수 있어요.';
    if(error?.code==='auth/popup-blocked')return '팝업이 차단됐어요. Safari 팝업 차단 설정을 확인한 뒤 다시 눌러 주세요.';
    if(error?.code==='auth/unauthorized-domain')return '이 사이트의 로그인 도메인 설정을 확인해야 해요.';
    return '로그인 연결을 완료하지 못했어요. 인터넷 연결을 확인한 뒤 다시 시도해 주세요.';
  };
  const perform=async action=>{
    if(busy)return;busy=true;render();
    try{await action();}catch(error){status(errors(error));}finally{busy=false;render();}
  };
  session.subscribe(user=>{render();if(user)status('Google 로그인 완료. 실시간 버스·카카오 도보 정보는 아직 준비 중이에요.');});
  $('account-button').addEventListener('click',()=>{if(!dialog.open)dialog.showModal();});
  $('account-close').addEventListener('click',()=>dialog.close());
  $('account-prepare').addEventListener('click',()=>perform(async()=>{status('Google 로그인 연결을 준비 중이에요…');await session.prepare();if(!session.user)status('준비됐어요. 아래 버튼을 눌러 Google 계정을 선택해 주세요.');}));
  $('account-login').addEventListener('click',()=>perform(()=>{status('Google 창에서 계정을 선택해 주세요.');return session.login();}));
  $('account-logout').addEventListener('click',()=>perform(async()=>{await session.logout();status('로그아웃했어요.');}));
  $('account-copy').addEventListener('click',async()=>{
    if(!session.user||busy)return;
    try{await clipboard.writeText(session.user.uid);status('계정 ID를 복사했어요. 직원1 채팅에 보내 주세요. 비밀번호나 인증 토큰은 보내지 마세요.');}
    catch{$('account-uid').select();status('계정 ID 칸을 길게 눌러 직접 복사해 주세요.');}
  });
  render();return session;
}
