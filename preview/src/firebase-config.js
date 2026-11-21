// Public Firebase web-app identifiers, NOT server credentials or authorization.
// Access is enforced by Firebase rules and the backend's owner UID allowlist.
export const FIREBASE_CONFIG = Object.freeze({
  apiKey:'AIzaSyCerySWGWHDhz1rm1aOYeBP_-v_SVFbsZE',
  authDomain:'myeotbun-georeum.firebaseapp.com',
  projectId:'myeotbun-georeum',
  storageBucket:'myeotbun-georeum.firebasestorage.app',
  messagingSenderId:'488598307207',
  appId:'1:488598307207:web:80e018002f65d0f6d21322'
});
export const NAVIGATION_API_ORIGIN='https://myeotbun-georeum-navigation.onrender.com';
// Origin of the deployed friend-sharing server (server/meeting-server.mjs), e.g. 'https://example.onrender.com'.
// While empty, the meeting screen asks for a server address because no shared server exists yet.
export const SHARING_SERVER_ORIGIN='';
