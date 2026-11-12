import {FIREBASE_CONFIG} from './firebase-config.js';
async function loadFirebase(){
  // Loaded only after the user explicitly chooses to prepare Google login.
  const [appSDK,authSDK]=await Promise.all([
    import('https://www.gstatic.com/firebasejs/13.3.0/firebase-app.js'),
    import('https://www.gstatic.com/firebasejs/13.3.0/firebase-auth.js')
  ]);
  const app=appSDK.getApps().find(app=>app.name==='walking-client')||appSDK.initializeApp(FIREBASE_CONFIG,'walking-client');
  const auth=authSDK.getAuth(app);
  await authSDK.setPersistence(auth,authSDK.browserSessionPersistence);
  await auth.authStateReady();
  const provider=new authSDK.GoogleAuthProvider();provider.setCustomParameters({prompt:'select_account'});
  return {signIn:()=>authSDK.signInWithPopup(auth,provider),signOut:()=>authSDK.signOut(auth),
    watch:callback=>authSDK.onAuthStateChanged(auth,callback),getToken:()=>auth.currentUser?.getIdToken(),user:()=>auth.currentUser};
}
export function createAccountSession({loadSDK=loadFirebase}={}){
  let sdk=null,pending=null,user=null;const listeners=new Set();
  const notify=value=>{user=value;for(const fn of listeners)fn(user);};
  return {
    get user(){return user;},get ready(){return sdk!==null;},
    subscribe(fn){listeners.add(fn);fn(user);return ()=>listeners.delete(fn);},
    prepare(){
      if(sdk)return Promise.resolve();
      if(!pending)pending=loadSDK().then(value=>{sdk=value;sdk.watch(notify);notify(sdk.user());}).finally(()=>{pending=null;});
      return pending;
    },
    login(){if(!sdk)throw Error('LOGIN_NOT_READY');return sdk.signIn();},
    async logout(){if(!sdk)return;await sdk.signOut();notify(null);},
    async getIdToken(){if(!sdk||!user)throw Error('AUTH_REQUIRED');const token=await sdk.getToken();if(!token)throw Error('AUTH_REQUIRED');return token;}
  };
}
