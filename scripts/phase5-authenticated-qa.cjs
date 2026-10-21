// Run against an unconfigured local static export; see the Phase 5 handoff.
const base = process.env.WEAVE_QA_BASE_URL || 'http://127.0.0.1:8095';
const { chromium }=require(process.env.WEAVE_PLAYWRIGHT_MODULE || 'playwright');const fs=require('fs');
(async()=>{
const b=await chromium.launch({channel:'chrome',headless:true});
const p=await b.newPage({viewport:{width:320,height:568},reducedMotion:'reduce'});const errors=[];p.on('pageerror',e=>errors.push(e.message));
fs.mkdirSync('artifacts/phase-5', { recursive: true });
let completed=true; let searchMode='empty';
await p.addInitScript(()=>sessionStorage.setItem('access_token','local-qa-token'));
await p.route('**/*',r=>{
 const u=new URL(r.request().url());if(!u.pathname.includes('/v2/'))return r.continue();
 const path=u.pathname;let data={items:[]};let status=200;
 if(path.endsWith('/users/me')){ data={user_id:'00000000-0000-4000-8000-000000000001',username:'local-qa',full_name:'Local QA',bio:'Builds things',onboarding_completed:completed}; if(r.request().method()==='PATCH'){status=503;data={error:'Profile save unavailable. Try again.'};} }
 if(path.endsWith('/search')){if(searchMode==='error'){status=503;data={error:'Search unavailable'};}else data={schema_version:2,items:[],next_cursor:null,mode:searchMode==='fallback'?'lexical':'hybrid'};}
 return r.fulfill({status,contentType:'application/json',body:JSON.stringify(status===200?{success:true,data}:{success:false,error:data.error})});
});
await p.goto(`${base}/profile`);await p.getByLabel('Edit profile',{exact:true}).click();
for(const label of ['Username','Bio','Name']){const f=p.getByRole('textbox',{name:label,exact:true});await f.focus();await f.scrollIntoViewIfNeeded();const box=await f.boundingBox();if(box.y<0||box.y+box.height>568)throw Error('Profile input obscured');}
await p.getByRole('textbox',{name:'Name',exact:true}).fill('Edited QA name');
await p.getByRole('button',{name:'Save profile changes'}).click();await p.getByText('Profile save unavailable. Try again.',{exact:true}).waitFor();if(await p.getByRole('textbox',{name:'Name',exact:true}).inputValue() !== 'Edited QA name')throw Error('Profile error lost the draft');await p.screenshot({path:'artifacts/phase-5/profile-error-320.png'});await p.getByRole('button',{name:'Cancel',exact:true}).click();
await p.goto(`${base}/explore`);const search=p.getByRole('textbox',{name:'Search repositories, people and Lists'});await search.fill('unlikely query');await p.getByText('No results found. Try another search or filter.',{exact:true}).waitFor();
searchMode='error';await search.fill('error query');await p.getByText('Could not load results. Check your connection and try again.',{exact:true}).waitFor();
searchMode='fallback';await p.getByRole('button',{name:'Try again',exact:true}).click();await p.getByText('Showing keyword matches. Some related results may be unavailable.',{exact:true}).waitFor();
await p.getByRole('button',{name:'Clear search',exact:true}).click();if(await search.inputValue()!=='')throw Error('Clear failed');if(!await search.evaluate(el=>el===document.activeElement))throw Error('Clear lost focus');
completed=false;await p.goto(`${base}/onboarding/create-profile`);await p.getByRole('textbox',{name:'Bio (optional)'}).fill('long bio '.repeat(100));await p.getByRole('textbox',{name:'Username',exact:true}).fill('invalid name!');await p.getByText(/Username must|letters|lowercase/i).first().scrollIntoViewIfNeeded();await p.screenshot({path:'artifacts/phase-5/onboarding-320.png'});
fs.writeFileSync('artifacts/phase-5/authenticated-browser-checks.json',JSON.stringify({viewport:'320x568',fixture:'Intercepted local QA user and API responses; no live service writes',checks:['profile fields reachable','profile save error retains modal and draft','Explore empty state','Explore error/retry','Explore keyword fallback','Explore clear restores focus','onboarding long bio and invalid username'],errors},null,2));await b.close();if(errors.length)throw Error(errors.join('\n'));
})().catch(e=>{console.error(e);process.exit(1)});
