// Server-only. Never export service-account material to the browser or static build.
import {createHash} from 'node:crypto';

const uidValid=uid=>typeof uid==='string'&&uid.length>0&&uid.length<=128;
async function bounded(promise){
  let timer;
  try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Security timeout')),5000);})]);}
  finally{clearTimeout(timer);}
}
const positive=(n,max)=>Number.isSafeInteger(n)&&n>0&&n<=max;
export function createFirebaseSecurity({auth,db,projectId,allowedUids=[],perUserDailyLimit=30,perUserMinuteLimit=6,now=Date.now}={}) {
  if(!auth||!db||!projectId||!allowedUids.length||allowedUids.length>100||!allowedUids.every(uidValid))throw Error('Firebase security configuration incomplete');
  if(!positive(perUserDailyLimit,1000)||!positive(perUserMinuteLimit,60))throw Error('Invalid user quota');
  const allowed=new Set(allowedUids);
  return {
    async authorize(req){
      const header=req.headers.authorization;
      if(typeof header!=='string'||header.length>8192||!/^Bearer [A-Za-z0-9_.-]+$/.test(header))return false;
      try {
        // Admin SDK checks signature, issuer, audience, expiry, revocation and disabled user.
        const claims=await bounded(auth.verifyIdToken(header.slice(7),true));
        if(claims.aud!==projectId||claims.iss!==`https://securetoken.google.com/${projectId}`||
           !uidValid(claims.uid)||!allowed.has(claims.uid)||claims.email_verified!==true||
           claims.firebase?.sign_in_provider!=='google.com')return false;
        return Object.freeze({uid:claims.uid});
      }catch{return false;}
    },
    async reserveQuota({day,limit,uid}){
      if(!allowed.has(uid)||!positive(limit,1000)||day!==new Date(now()).toISOString().slice(0,10))return false;
      const userHash=createHash('sha256').update(uid).digest('hex');
      const globalRef=db.collection('navigationQuota').doc(`global_${day}`);
      const userRef=db.collection('navigationQuota').doc(`user_${day}_${userHash}`);
      try {
        // No locations, routes, API keys, email addresses or tokens stored here.
        return await bounded(db.runTransaction(async tx=>{
          if(day!==new Date(now()).toISOString().slice(0,10))return false;
          const [globalSnap,userSnap]=await tx.getAll(globalRef,userRef);
          const g=globalSnap.exists?globalSnap.data():{count:0};
          const u=userSnap.exists?userSnap.data():{count:0,minute:-1,minuteCount:0};
          // Corrupt counters must fail closed instead of silently resetting budgets.
          if(!Number.isSafeInteger(g.count)||g.count<0||!Number.isSafeInteger(u.count)||u.count<0||
             !Number.isSafeInteger(u.minute)||!Number.isSafeInteger(u.minuteCount)||u.minuteCount<0)return false;
          const minute=Math.floor(now()/60000);
          // Backward clock movement must not reset minute limits.
          const minuteCount=minute>u.minute?0:u.minuteCount;
          if(g.count>=limit||u.count>=perUserDailyLimit||minuteCount>=perUserMinuteLimit)return false;
          tx.set(globalRef,{count:g.count+1,day});
          tx.set(userRef,{count:u.count+1,day,minute:Math.max(minute,u.minute),minuteCount:minuteCount+1});
          return true;
        },{maxAttempts:3}));
      }catch{return false;}
    }
  };
}

export async function loadFirebaseSecurity(env=process.env){
  const projectId=env.NAV_FIREBASE_PROJECT_ID;
  const allowedUids=(env.NAV_ALLOWED_FIREBASE_UIDS||'').split(',').map(x=>x.trim()).filter(Boolean);
  if(!projectId||!allowedUids.length||!env.NAV_FIREBASE_SERVICE_ACCOUNT_JSON)return null;
  let credential;
  try {
    credential=JSON.parse(env.NAV_FIREBASE_SERVICE_ACCOUNT_JSON);
    if(credential.type!=='service_account'||credential.project_id!==projectId||
       typeof credential.private_key!=='string'||credential.client_email!==`navigation-backend@${projectId}.iam.gserviceaccount.com`)return null;
    const [{initializeApp,cert},{getAuth},{getFirestore}]=await Promise.all([
      import('firebase-admin/app'),import('firebase-admin/auth'),import('firebase-admin/firestore')]);
    const app=initializeApp({credential:cert(credential),projectId},'navigation-security');
    const db=getFirestore(app,env.NAV_FIRESTORE_DATABASE_ID||'(default)');
    return createFirebaseSecurity({auth:getAuth(app),db,projectId,allowedUids,
      perUserDailyLimit:Number(env.NAV_PER_USER_DAILY_CALLS||30),
      perUserMinuteLimit:Number(env.NAV_PER_USER_MINUTE_CALLS||6)});
  }catch{return null;}
}
