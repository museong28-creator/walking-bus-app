// The whole app sits behind a Google login. Nothing is loaded from Google until the button is pressed.
export function loginErrorMessage(error) {
  if (['auth/popup-closed-by-user','auth/cancelled-popup-request'].includes(error?.code)) return '로그인을 취소했어요. 다시 시도할 수 있어요.';
  if (error?.code === 'auth/popup-blocked') return '팝업이 차단됐어요. Safari 팝업 차단 설정을 확인한 뒤 다시 눌러 주세요.';
  if (error?.code === 'auth/unauthorized-domain') return '이 사이트의 로그인 도메인 설정을 확인해야 해요.';
  return '로그인 연결을 완료하지 못했어요. 인터넷 연결을 확인한 뒤 다시 시도해 주세요.';
}

export function initLoginGate({document: doc = document, session, onSignedIn = () => {}, onSignedOut = () => {}} = {}) {
  const $ = id => doc.getElementById(id);
  const initial = $('login-status').textContent;
  let busy = false, signedIn = false;
  const render = () => {
    $('login-start').disabled = busy;
    // Loading the login library takes a network round trip. Safari only allows the account
    // window to open directly from a tap, so choosing the account is a second tap.
    $('login-start').textContent = busy ? '연결 중…' : session.ready ? 'Google 계정 선택' : 'Google로 시작하기';
  };
  $('login-start').addEventListener('click', async () => {
    if (busy || session.user) return;
    busy = true; render();
    try {
      if (!session.ready) {
        await session.prepare();
        if (!session.user) $('login-status').textContent = '준비됐어요. 한 번 더 눌러 Google 계정을 선택해 주세요.';
      } else {
        $('login-status').textContent = 'Google 창에서 계정을 선택해 주세요.';
        await session.login();
      }
    } catch (error) { $('login-status').textContent = loginErrorMessage(error); }
    finally { busy = false; render(); }
  });
  session.subscribe(user => {
    doc.body?.classList.toggle('locked', !user);
    if (user && !signedIn) { signedIn = true; onSignedIn(user); }
    else if (!user && signedIn) { signedIn = false; $('login-status').textContent = initial; onSignedOut(); }
    render();
  });
  render();
}
