// Run against an unconfigured local static export; see the Phase 5 handoff.
const base = process.env.WEAVE_QA_BASE_URL || 'http://127.0.0.1:8095';
const { chromium } = require(process.env.WEAVE_PLAYWRIGHT_MODULE || 'playwright');
const fs = require('fs');
(async()=> {
 const browser = await chromium.launch({channel:'chrome',headless:true});
 const page = await browser.newPage({viewport:{width:320,height:568}, reducedMotion:'reduce'});
 const errors=[]; page.on('pageerror', e=>errors.push(e.message));
 const checks=[];
 fs.mkdirSync('artifacts/phase-5', { recursive: true });
 for (const route of ['login','sign-up-email','forgot-password','reset-password']) {
  await page.goto(`${base}/${route}`); await page.waitForTimeout(800);
  const expectedInputs = { login: 2, 'sign-up-email': 5, 'forgot-password': 1, 'reset-password': 2 };
  if(await page.locator('input').count() !== expectedInputs[route]) throw Error(`${route} did not render its form`);
  for(const viewport of [{width:320,height:568},{width:360,height:640},{width:320,height:300}]) {
   await page.setViewportSize(viewport);
   const fields=page.locator('input');
   for(let i=0;i<await fields.count();i++) {
    const field=fields.nth(i);await field.focus(); await field.scrollIntoViewIfNeeded();
    const b=await field.boundingBox(); if(!b||b.y<0||b.y+b.height>viewport.height+1)throw Error(`${route} input ${i} obscured ${JSON.stringify(b)}`);
   }
   const buttons=page.getByRole('button');
   for(let i=0;i<await buttons.count();i++) {
    const button=buttons.nth(i);if(!await button.isVisible())continue;
    await button.scrollIntoViewIfNeeded();const b=await button.boundingBox();
    if(!b||b.y<0||b.y+b.height>viewport.height+1)throw Error(`${route} button unreachable`);
   }
   const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1);
   if(overflow)throw Error(`${route} horizontal overflow`);
   checks.push({route,viewport,inputs:await fields.count(),scrollableActions:true,noHorizontalOverflow:true});
  }
  await page.setViewportSize({width:320,height:568});
  await page.screenshot({path:`artifacts/phase-5/${route}-320.png`});
 }
 fs.writeFileSync('artifacts/phase-5/browser-checks.json',JSON.stringify({checks,errors,note:'Chrome layout checks; 320x300 simulates constrained space, not a native keyboard.'},null,2));
 await browser.close(); if(errors.length)throw Error(errors.join('\n'));
})().catch(e=>{console.error(e);process.exit(1)});
