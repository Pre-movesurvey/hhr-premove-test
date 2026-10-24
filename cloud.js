/* HHR V1.7 TEST — per-survey merge, no automatic destructive downloads. */
let cloudToken=null,cloudUser=null,cloudRefreshToken=null,cloudExpiresAt=0;
const ce=id=>document.getElementById(id);
function cloudStatus(t){ce('cloudStatus').textContent=t}
function cloudConfig(){let url=ce('sbUrl').value.trim().replace(/\/$/,''),key=ce('sbKey').value.trim();if(!/^https:\/\/[a-z0-9-]+\.supabase\.co$/i.test(url)||!key)throw Error('Enter valid Supabase URL and publishable key');return {url,key}}
async function cloudRequest(path,method='GET',body=null,token=null,extra={}){let c=cloudConfig(),headers={'apikey':c.key,'Content-Type':'application/json',...extra};if(token)headers.Authorization='Bearer '+token;let r=await fetch(c.url+path,{method,headers,body:body===null?undefined:JSON.stringify(body)});let t=await r.text(),d;try{d=t?JSON.parse(t):null}catch{d=t}if(!r.ok)throw Error(d?.message||d?.error_description||d?.msg||d?.error||`HTTP ${r.status}`);return d}
function cloudStoreSession(r){cloudToken=r.access_token;cloudRefreshToken=r.refresh_token;cloudUser=r.user?.id||cloudUser;cloudExpiresAt=Date.now()+Math.max(60,r.expires_in||3600)*1000;localStorage.setItem('hhr_cloud_session',JSON.stringify({access_token:cloudToken,refresh_token:cloudRefreshToken,user_id:cloudUser,expires_at:cloudExpiresAt}))}
async function cloudEnsureSession(){if(!cloudRefreshToken)throw Error('Sign in first');if(cloudToken&&Date.now()<cloudExpiresAt-90000)return;let r=await cloudRequest('/auth/v1/token?grant_type=refresh_token','POST',{refresh_token:cloudRefreshToken});cloudStoreSession(r)}
async function cloudInit(){try{let c=JSON.parse(localStorage.getItem('hhr_cloud_config')||'null');if(c){ce('sbUrl').value=c.url||'';ce('sbKey').value=c.key||''}let s=JSON.parse(localStorage.getItem('hhr_cloud_session')||'null');if(s?.refresh_token){cloudToken=s.access_token;cloudRefreshToken=s.refresh_token;cloudUser=s.user_id;cloudExpiresAt=s.expires_at||0;await cloudEnsureSession();cloudStatus('Signed in ✓ · Ready for Safe Sync');return}}catch(e){cloudStatus('Session unavailable · '+e.message+' · Local data is safe');return}cloudStatus('Not signed in · Local data is safe')}
async function cloudSignIn(){try{cloudStatus('Signing in…');localStorage.setItem('hhr_cloud_config',JSON.stringify(cloudConfig()));let r=await cloudRequest('/auth/v1/token?grant_type=password','POST',{email:ce('sbEmail').value.trim(),password:ce('sbPassword').value});cloudStoreSession(r);ce('sbPassword').value='';cloudStatus('Signed in ✓ · Ready for Safe Sync')}catch(e){cloudStatus('Sign-in failed: '+e.message)}}
function cloudSignOut(){localStorage.removeItem('hhr_cloud_session');cloudToken=cloudRefreshToken=cloudUser=null;cloudExpiresAt=0;ce('sbPassword').value='';cloudStatus('Signed out · Local data unchanged')}
// Sync bookkeeping is committed in the same IndexedDB snapshot as surveys.
function syncMetaKey(){return 'hhr_v17_sync_'+cloudUser}
function syncMeta(){let all=state._cloudSyncMeta||{};return structuredClone(all[cloudUser]||{})}
async function syncCommit(nextSurveys, nextMeta){
  // Do not publish changed in-memory state until IndexedDB transaction completes.
  const previous=state;
  const candidate={...state,surveys:nextSurveys,_cloudSyncMeta:{...(state._cloudSyncMeta||{}),[cloudUser]:nextMeta}};
  const snapshot=structuredClone(candidate);
  await saveChain;
  await new Promise((resolve,reject)=>{
    const tx=db.transaction(STORE,'readwrite');
    tx.objectStore(STORE).put(snapshot,'app');
    tx.oncomplete=resolve;
    tx.onerror=()=>reject(tx.error||Error('IndexedDB write failed'));
    tx.onabort=()=>reject(tx.error||Error('IndexedDB transaction aborted'));
  });
  state=candidate;mark('Saved locally ✓');
}
function surveyFingerprint(s){return JSON.stringify(s)}
function newConflictSurvey(s){let c=structuredClone(s);c.id=crypto.randomUUID();c.ref=(s.ref||'HHR-SV')+'-CONFLICT-'+crypto.randomUUID().slice(0,5).toUpperCase();c.notes=(c.notes||'')+'\n[Sync conflict: preserved local version. Compare with the original before use.]';return c}
async function cloudSync(){
  const button=ce('safeSyncButton');if(button.disabled)return;
  button.disabled=true;let localCommitted=false;
  try{
    await cloudEnsureSession();if(!cloudUser||!cloudToken)throw Error('Sign in first');
    await saveChain;
    if(!confirm('SAFE SYNC merges surveys by ID. Conflicting edits are kept as separate CONFLICT surveys. Continue?'))return;
    cloudStatus('Synchronizing surveys…');
    let meta=syncMeta();
    // Migrate previous-version metadata only if no durable metadata exists yet.
    if(!Object.keys(meta).length){try{meta=JSON.parse(localStorage.getItem(syncMetaKey())||'{}')}catch{meta={}}}
    const rows=await cloudRequest('/rest/v1/hhr_survey_records?select=survey_id,revision,payload&user_id=eq.'+encodeURIComponent(cloudUser),'GET',null,cloudToken);
    if(!Array.isArray(rows))throw Error('Unexpected cloud response');
    const remote=new Map(rows.map(r=>[r.survey_id,r]));
    const nextSurveys=structuredClone(state.surveys);
    const local=new Map(nextSurveys.map(s=>[s.id,s]));
    let pulled=0,pushed=0,conflicts=0;const errors=[];
    for(const r of rows){
      if(!r.payload||r.payload.id!==r.survey_id)throw Error('Invalid cloud survey payload: '+r.survey_id);
      const l=local.get(r.survey_id),known=meta[r.survey_id],remoteFp=surveyFingerprint(r.payload);
      if(!l){let copy=structuredClone(r.payload);nextSurveys.push(copy);local.set(copy.id,copy);meta[r.survey_id]={revision:r.revision,fingerprint:remoteFp};pulled++;continue}
      const localFp=surveyFingerprint(l);
      if(localFp===remoteFp){meta[r.survey_id]={revision:r.revision,fingerprint:remoteFp};continue}
      if(known&&known.revision===r.revision){
        // Remote unchanged since last sync: preserve local edit for upload.
        continue;
      }
      if(!known||localFp!==known.fingerprint){
        let copy=newConflictSurvey(l);nextSurveys.push(copy);local.set(copy.id,copy);conflicts++;
      }
      let ix=nextSurveys.findIndex(s=>s.id===r.survey_id);
      nextSurveys[ix]=structuredClone(r.payload);local.set(r.survey_id,nextSurveys[ix]);pulled++;
      meta[r.survey_id]={revision:r.revision,fingerprint:remoteFp};
    }
    // Atomically save downloaded surveys AND their revision metadata before uploading.
    await syncCommit(nextSurveys,meta);localCommitted=true;
    for(const s of nextSurveys){
      const known=meta[s.id],r=remote.get(s.id),fp=surveyFingerprint(s);
      if(known&&known.fingerprint===fp)continue;
      try{
        let result;
        if(!r){result=await cloudRequest('/rest/v1/hhr_survey_records','POST',{user_id:cloudUser,survey_id:s.id,revision:1,payload:s},cloudToken,{'Prefer':'return=representation'});}
        else if(known&&known.revision===r.revision){result=await cloudRequest('/rest/v1/hhr_survey_records?user_id=eq.'+encodeURIComponent(cloudUser)+'&survey_id=eq.'+encodeURIComponent(s.id)+'&revision=eq.'+r.revision,'PATCH',{revision:r.revision+1,payload:s},cloudToken,{'Prefer':'return=representation'});}
        else throw Error('Remote revision changed; retry Safe Sync');
        if(!Array.isArray(result)||result.length!==1)throw Error('Cloud did not confirm one updated record');
        const nextMeta={...meta,[s.id]:{revision:result[0].revision,fingerprint:fp}};
        await syncCommit(structuredClone(state.surveys),nextMeta);
        meta=nextMeta;pushed++;
      }catch(e){errors.push((s.ref||s.id)+': '+e.message)}
    }
    tab('dashboard');
    cloudStatus('Safe Sync: '+pushed+' uploaded, '+pulled+' downloaded, '+conflicts+' conflict copies'+(errors.length?' · '+errors.length+' FAILED — '+errors.slice(0,2).join('; '):' · Cloud synchronized ✓'));
  }catch(e){cloudStatus('Safe Sync failed: '+e.message+(localCommitted?' · Some changes were saved locally; retry safely':' · Cloud data not merged locally'))}
  finally{button.disabled=false}
}
// Old destructive snapshot operations are intentionally disabled in V1.7.
function cloudPull(){cloudStatus('Old snapshot download disabled to protect local surveys. Use Safe Sync.')}
function cloudPush(){cloudStatus('Old snapshot upload disabled to protect cloud surveys. Use Safe Sync.')}
