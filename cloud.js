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
function syncMetaKey(){return 'hhr_v17_sync_'+cloudUser}
function syncMeta(){try{return JSON.parse(localStorage.getItem(syncMetaKey())||'{}')}catch{return {}}}
function syncSetMeta(m){localStorage.setItem(syncMetaKey(),JSON.stringify(m))}
function surveyFingerprint(s){return JSON.stringify(s)}
function newConflictSurvey(s){let c=structuredClone(s);c.id=crypto.randomUUID();c.ref=(s.ref||'HHR-SV')+'-CONFLICT-'+crypto.randomUUID().slice(0,5).toUpperCase();c.notes=(c.notes||'')+'\n[Sync conflict: preserved local version. Compare with the original before use.]';return c}
async function cloudSync(){const button=ce('safeSyncButton');if(button.disabled)return;button.disabled=true;try{
  await cloudEnsureSession();if(!cloudUser||!cloudToken)throw Error('Sign in first');await saveChain;
  if(!confirm('SAFE SYNC will merge surveys by ID. It never deletes surveys. Conflicting edits are preserved as a separate CONFLICT survey. Export Backup first. Continue?'))return;
  cloudStatus('Synchronizing surveys…');
  let meta=syncMeta(),rows=await cloudRequest('/rest/v1/hhr_survey_records?select=survey_id,revision,payload&user_id=eq.'+encodeURIComponent(cloudUser),'GET',null,cloudToken),remote=new Map(rows.map(r=>[r.survey_id,r]));
  let local=new Map(state.surveys.map(s=>[s.id,s])),pulled=0,pushed=0,conflicts=0,errors=[];
  // Fetch each remote record, preserving local changes when remote revision has advanced.
  for(const r of rows){let l=local.get(r.survey_id),known=meta[r.survey_id];if(!l){state.surveys.push(structuredClone(r.payload));local.set(r.survey_id,r.payload);meta[r.survey_id]={revision:r.revision,fingerprint:surveyFingerprint(r.payload)};pulled++;continue}
    if(known&&known.revision===r.revision){continue}
    if(known&&surveyFingerprint(l)!==known.fingerprint&&surveyFingerprint(l)!==surveyFingerprint(r.payload)){
      let copy=newConflictSurvey(l);state.surveys.push(copy);local.set(copy.id,copy);conflicts++;
    }else if(!known&&surveyFingerprint(l)!==surveyFingerprint(r.payload)){
      let copy=newConflictSurvey(l);state.surveys.push(copy);local.set(copy.id,copy);conflicts++;
    }
    if(surveyFingerprint(l)!==surveyFingerprint(r.payload)){let ix=state.surveys.findIndex(s=>s.id===r.survey_id);state.surveys[ix]=structuredClone(r.payload);local.set(r.survey_id,r.payload);pulled++}
    meta[r.survey_id]={revision:r.revision,fingerprint:surveyFingerprint(r.payload)};
  }
  await persist();syncSetMeta(meta);
  for(const s of state.surveys){let known=meta[s.id],r=remote.get(s.id),fp=surveyFingerprint(s);if(known&&known.fingerprint===fp)continue;
    try{let result;if(!r){result=await cloudRequest('/rest/v1/hhr_survey_records','POST',{user_id:cloudUser,survey_id:s.id,revision:1,payload:s},cloudToken,{'Prefer':'return=representation'});}
      else if(known&&known.revision===r.revision){result=await cloudRequest('/rest/v1/hhr_survey_records?user_id=eq.'+encodeURIComponent(cloudUser)+'&survey_id=eq.'+encodeURIComponent(s.id)+'&revision=eq.'+r.revision,'PATCH',{revision:r.revision+1,payload:s},cloudToken,{'Prefer':'return=representation'});if(!result.length)throw Error('Revision conflict; no overwrite');}
      else throw Error('Unresolved remote revision; no overwrite');
      if(!result?.length)throw Error('No confirmation from server');meta[s.id]={revision:result[0].revision,fingerprint:fp};syncSetMeta(meta);pushed++;
    }catch(e){errors.push((s.ref||s.id)+': '+e.message)}
  }
  tab('dashboard');cloudStatus('Safe Sync: '+pushed+' uploaded, '+pulled+' downloaded, '+conflicts+' conflict copies'+(errors.length?' · '+errors.length+' FAILED — '+errors.slice(0,2).join('; '):' · Cloud synchronized ✓'));
}catch(e){cloudStatus('Safe Sync failed: '+e.message+' · Local surveys unchanged')}finally{button.disabled=false}}
// Old destructive snapshot operations are intentionally disabled in V1.7.
function cloudPull(){cloudStatus('Old snapshot download disabled to protect local surveys. Use Safe Sync.')}
function cloudPush(){cloudStatus('Old snapshot upload disabled to protect cloud surveys. Use Safe Sync.')}
