// Run with Playwright available to Node: node docs/prototype/index.test.cjs
// Optional: PROTOTYPE_URL, PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH, ARTIFACT_DIR.
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const { mkdir } = require('node:fs/promises');
const { pathToFileURL } = require('node:url');
const path = require('node:path');
const url = process.env.PROTOTYPE_URL || 'http://10.10.0.2:8091/index.html';
const artifacts = process.env.ARTIFACT_DIR || '/tmp/djym-prototype-review';
const key = 'fieldnotes-prototype-v1';
const seed = {
 program: 'lower', // Legacy selection must not override the title.
 draft: { text: '03.10.2026 upper\n', copy: false },
 records: [
  { id:'own-upper', date:'2026-10-01', program:'upper', text:'01.10.2026 upper\nжим в нахилі сміт 67-8 -7\nпідтягування 83-8 -7' },
  { id:'other-title', date:'2026-10-02', program:'upper', text:'02.10.2026 push\nжим в нахилі сміт 99-1' },
  { id:'other-exercise', date:'2026-10-02', program:'upper', text:'02.10.2026 upper\nскручування 12-20' },
  { id:'future', date:'2026-10-04', program:'upper', text:'04.10.2026 upper\nжим в нахилі сміт 100-1' },
  { id:'same-day', date:'2026-10-03', program:'upper', text:'03.10.2026 upper\nжим в нахилі сміт 101-1' },
  { id:'free-title', date:'2026-10-01', program:null, text:'01.10.2026 My free workout\nмоя вправа 22-9 -8' },
  { id:'legacy-date', date:'2018-05-02', program:null, text:'02.05 legacy date\nold exercise' }
 ]
};
(async () => {
 const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? {executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH} : {}) });
 const context = await browser.newContext({ viewport:{width:390,height:844}, isMobile:true, hasTouch:true, deviceScaleFactor:1, timezoneId:process.env.PROTOTYPE_TIMEZONE || 'America/Los_Angeles' });
 const page = await context.newPage();
 const errors=[];
 page.on('pageerror',error=>errors.push(error.message));
 let externalRequests=0;
 page.on('request',request=>{ if(!request.url().startsWith(url) && !request.url().startsWith('file:'))externalRequests++; });
 await page.goto(url);
 await page.evaluate(({key,seed})=>localStorage.setItem(key,JSON.stringify(seed)),{key,seed});
 await page.reload();
 const editor=page.locator('#editor'),ghost=page.locator('#ghost');
 const value=()=>editor.inputValue();
 const saved=()=>page.evaluate(key=>JSON.parse(localStorage.getItem(key)),key);
 async function type(text) {await editor.fill(text);await editor.focus();}
 async function expectGhost(text) {assert.equal(await ghost.textContent(),text);}
 await assert.doesNotReject(()=>page.waitForFunction(()=>document.title==='djym'));
 // Exact normalized title matching, independent of the legacy selected program.
 for(const title of ['upper','Upper','  uPpEr   ']) {
  await type('03.10.2026 '+title+'\n');
  await expectGhost('жим в нахилі сміт 67-8 -7');
 }
 await type('03.10.2026 LOWER\n');
 await expectGhost('присідання 70-10 -10 60-12');
 for(const title of ['upper extra','my unknown title','upper / strength','push']) {
  await type('03.10.2026 '+title+'\n');await expectGhost('');
 }
 await type('03.10.2026 my unknown title\nжим');await expectGhost('');
 // History is exact by title AND exercise, strictly before the workout day.
 await type('03.10.2026 upper\nжим в нахилі сміт');await expectGhost(' 67-8 -7');
 assert.match(await page.locator('#suggestion-source').textContent(),/1 Oct 2026 · your history/);
 await type('03.10.2026 upper\nпідтягування');await expectGhost(' 83-8 -7');
 await type('03.10.2026 upper\nжим 67-');await expectGhost('');
 await type('03.10.2026 upper\nжим в нахилі сміт 67-');await expectGhost('8 -7');
 await type('03.10.2026 upper\nжим в нахилі сміт 68-');await expectGhost('');
 await type('03.10.2026 push\nжим в нахилі сміт');await expectGhost(' 99-1');
 await type('03.10.2026 My free workout\nмоя вправа');await expectGhost(' 22-9 -8');
 assert.equal((await saved()).records.length,seed.records.length);
 // Showing/positioning suggestions never mutates the text or completes a workout.
 const before='03.10.2026 upper\nжим';
 await type(before);const persistedBefore=await saved();await page.waitForTimeout(200);
 assert.equal(await value(),before);assert.equal((await saved()).draft.text,before);
 assert.equal((await saved()).records.length,seed.records.length);
 await editor.press('Tab');assert.equal(await value(),'03.10.2026 upper\nжим в нахилі сміт 67-8 -7');
 assert.equal((await saved()).draft.text,await value());
 assert.equal(persistedBefore.draft.text,before);
 // Selection, mid-note editing, and IME never trigger an acceptance.
 await type('03.10.2026 upper\nжим');
 await editor.evaluate(el=>{el.setSelectionRange(17,20);el.dispatchEvent(new Event('select'));});await expectGhost('');
 await editor.press('x');assert.match(await value(),/x/);
 await type('03.10.2026 upper\nжим\nanything');
 await editor.evaluate(el=>{el.setSelectionRange(19,19);el.dispatchEvent(new Event('select'));});await expectGhost('');
 await type(before);
 await editor.dispatchEvent('compositionstart');await expectGhost('');
 await editor.dispatchEvent('compositionend');assert.notEqual(await ghost.textContent(),'');
 // Accessible tap acceptance.
 await page.locator('#accept').tap();assert.equal(await value(),'03.10.2026 upper\nжим в нахилі сміт 67-8 -7');
 // Real Chromium touch events: right accepts, left/vertical/selection/long press do not.
 const cdp=await context.newCDPSession(page);
 async function swipe(dx,dy=0,{existing=false,hold=0}={}) {
  const point=await page.evaluate(existing=>{
   const range=document.createRange();range.selectNodeContents(document.getElementById(existing?'mirror-prefix':'ghost'));
   const rects=range.getClientRects();const rect=existing?rects[0]:rects[rects.length-1];
   return {x:rect.left+8,y:rect.top+rect.height/2};
  },existing);
  await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[point]});
  if(hold)await page.waitForTimeout(hold);
  for(let i=1;i<=5;i++)await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:point.x+dx*i/5,y:point.y+dy*i/5}]});
  await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
  await page.waitForTimeout(80);
 }
 await type('03.10.2026 upper\n');const swipeBefore=await value();
 await swipe(85);assert.equal(await value(),swipeBefore+'жим в нахилі сміт 67-8 -7');
 await type(swipeBefore);await swipe(-20);assert.equal(await value(),swipeBefore);
 await type(swipeBefore);await swipe(80,65);assert.equal(await value(),swipeBefore);
 await type(swipeBefore);await swipe(80,0,{existing:true});assert.equal(await value(),swipeBefore);
 await type(swipeBefore);await swipe(80,0,{hold:600});assert.equal(await value(),swipeBefore);
 await type(swipeBefore);
 await editor.evaluate(el=>{el.setSelectionRange(0,2);el.dispatchEvent(new Event('select'));});
 await swipe(80,0,{existing:true});assert.equal(await value(),swipeBefore);
 // Mobile widths and mirror geometry, including multiline wrapping and long tokens.
 await mkdir(artifacts,{recursive:true});
 for(const width of [320,360,375,390,414,430]) {
  await page.setViewportSize({width,height:844});
  await type('03.10.2026 upper\n');
  const geometry=await page.evaluate(()=>{
   const editor=document.getElementById('editor'),mirror=document.getElementById('mirror-text');
   const es=getComputedStyle(editor),ms=getComputedStyle(mirror),er=editor.getBoundingClientRect();
   const range=document.createRange();range.selectNodeContents(document.getElementById('ghost'));const gr=range.getClientRects()[0];
   return {overflow:document.documentElement.scrollWidth>innerWidth,editorWidth:er.width,mirrorWidth:mirror.getBoundingClientRect().width,font:es.font,mirrorFont:ms.font,padding:es.padding,mirrorPadding:ms.padding,ghostLeft:gr.left,expectedLeft:er.left+parseFloat(es.paddingLeft),ghostTop:gr.top,expectedTop:er.top+parseFloat(es.paddingTop)+parseFloat(es.lineHeight)};
  });
  assert.equal(geometry.overflow,false,`overflow at ${width}`);
  assert.equal(geometry.editorWidth,geometry.mirrorWidth);
  assert.equal(geometry.font,geometry.mirrorFont);assert.equal(geometry.padding,geometry.mirrorPadding);
  assert.ok(Math.abs(geometry.ghostLeft-geometry.expectedLeft)<1);
  assert.ok(Math.abs(geometry.ghostTop-geometry.expectedTop)<8);
  await page.screenshot({path:path.join(artifacts,`djym-${width}.png`),fullPage:true});
  await type('03.10.2026 '+ 'unmatched'.repeat(25)+'\n'+ 'довільна'.repeat(50));
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
 }
 // Long freely edited notes grow without an internal textarea scroll/mirror drift.
 await type('03.10.2026 upper\n'+Array(40).fill('довільна вправа 20-10').join('\n')+'\nжим');
 await editor.pressSequentially('и');
 assert.equal(await editor.evaluate(el=>el.scrollTop),0);
 assert.ok((await value()).endsWith('жими'));
 await page.setViewportSize({width:390,height:844});
 await type('03.10.2026 upper\nжим в нахилі сміт 67-8 -7\n');
 await expectGhost('підтягування 83-8 -7');
 await page.reload();await editor.focus();
 assert.equal((await saved()).draft.text,await value());
 assert.equal((await saved()).records.length,seed.records.length);
 // Native local date+time values retain their historical day, with no UTC shift.
 const setTimes=async(start,finish)=>{
  await page.locator('#workout-times').evaluate(el=>el.open=true);
  await page.locator('#started-at').fill(start);await page.locator('#completed-at').fill(finish);
 };
 await setTimes('2026-10-03T23:30','2026-10-04T00:15');
 await page.reload();
 assert.equal(await page.locator('#started-at').inputValue(),'2026-10-03T23:30');
 assert.equal(await page.locator('#completed-at').inputValue(),'2026-10-04T00:15');
 await page.locator('#complete').click();
 assert.equal((await saved()).draft,null);assert.equal((await saved()).records.length,seed.records.length+1);
 assert.equal((await saved()).records[0].startedAt,'2026-10-03T23:30');
 assert.equal((await saved()).records[0].completedAt,'2026-10-04T00:15');
 assert.match(await page.locator('#detail-times').textContent(),/2026-10-03 23:30.*2026-10-04 00:15/);
 assert.equal((await saved()).records[0].program,'upper');
 assert.equal((await saved()).records.find(r=>r.id==='free-title').program,null);
 await page.screenshot({path:path.join(artifacts,'djym-completed.png'),fullPage:true});
 await page.locator('#back-history').click();
 assert.equal(await page.locator('#history-list .record').count(),seed.records.length+5);
 await page.screenshot({path:path.join(artifacts,'djym-history.png'),fullPage:true});
 await page.locator('#history-toggle').click();
 await page.locator('#start-from-empty').click();
 await type('03.10.2026 arbitrary title\nanything 20-10');await page.locator('#complete').click();
 assert.equal((await saved()).records[0].program,null);
 const original=(await saved()).records[0];
 assert.equal(original.startedAt,'');assert.equal(original.completedAt,'');
 const recordCount=(await saved()).records.length;
 // Suspend a new draft, including its times, while editing a completed record.
 await page.locator('#new-workout').click();
 await type('01.02.2020 pending draft\nleave this untouched');
 await setTimes('2020-02-01T10:15','');
 const suspended=(await saved()).draft;
 async function openOwnRecord() {
  await page.locator('#history-toggle').click();
  await page.locator('#history-list .record').filter({hasText:'arbitrary title'}).click();
  await page.locator('#edit-again').click();
 }
 await openOwnRecord();
 assert.equal((await saved()).edit.targetId,original.id);
 assert.equal(await page.locator('#complete').textContent(),'Save changes');
 assert.equal(await page.locator('#edit-banner').isVisible(),true);
 await type('12.01.2020 revised title\nnew freely edited line');
 await setTimes('2020-01-12T23:45','2020-01-12T23:00');
 assert.deepEqual((await saved()).records.find(r=>r.id===original.id),original);
 assert.deepEqual((await saved()).draft,suspended);
 await page.reload();assert.equal(await value(),'12.01.2020 revised title\nnew freely edited line');
 assert.equal((await saved()).edit.targetId,original.id);
 assert.equal(await page.locator('#started-at').inputValue(),'2020-01-12T23:45');
 await page.locator('#complete').click();
 assert.match(await page.locator('#time-error').textContent(),/Finish must be at or after start/);
 assert.equal(await page.locator('#completed-at').getAttribute('aria-invalid'),'true');
 assert.deepEqual((await saved()).records.find(r=>r.id===original.id),original);
 assert.equal((await saved()).records.length,recordCount);
 await page.screenshot({path:path.join(artifacts,'djym-edit-invalid.png'),fullPage:true});
 await page.locator('#cancel-edit').click();
 assert.equal((await saved()).edit,undefined);
 assert.deepEqual((await saved()).records.find(r=>r.id===original.id),original);
 assert.deepEqual((await saved()).draft,suspended);
 await page.locator('#history-toggle').click();
 assert.equal(await value(),suspended.text);
 assert.equal(await page.locator('#started-at').inputValue(),suspended.startedAt);
 await openOwnRecord();
 assert.equal(await value(),original.text);
 await type('12.01.2020 revised title\nnew freely edited line');
 await setTimes('2020-01-12T23:45','2020-01-13T00:20');
 await page.locator('#toast').waitFor({state:'hidden'});
 await page.screenshot({path:path.join(artifacts,'djym-edit-historical.png'),fullPage:true});
 for(const width of [320,360,375,390,414,430]) {
  await page.setViewportSize({width,height:844});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,`time control overflow at ${width}`);
  for(const id of ['started-at','completed-at']) {
   const box=await page.locator('#'+id).boundingBox();
   assert.ok(box.x>=0 && box.x+box.width<=width,`${id} outside viewport at ${width}`);
  }
  if(width===320)await page.screenshot({path:path.join(artifacts,'djym-edit-times-320.png'),fullPage:true});
 }
 await page.setViewportSize({width:390,height:844});
 await page.locator('#complete').click();
 const updated=(await saved()).records.find(r=>r.id===original.id);
 assert.equal((await saved()).records.length,recordCount);
 assert.equal(updated.id,original.id);assert.equal(updated.date,'2020-01-12');
 assert.equal(updated.text,'12.01.2020 revised title\nnew freely edited line');
 assert.equal(updated.startedAt,'2020-01-12T23:45');assert.equal(updated.completedAt,'2020-01-13T00:20');
 assert.deepEqual((await saved()).draft,suspended);
 await page.locator('#edit-again').click();
 assert.equal(await page.locator('#started-at').inputValue(),updated.startedAt);
 assert.equal(await page.locator('#completed-at').inputValue(),updated.completedAt);
 // Equality is allowed; either time can be omitted or removed, without a default.
 await setTimes(updated.startedAt,updated.startedAt);await page.locator('#complete').click();
 assert.equal((await saved()).records.find(r=>r.id===original.id).completedAt,updated.startedAt);
 await page.locator('#edit-again').click();await setTimes('',updated.completedAt);
 await page.locator('#complete').click();
 assert.equal((await saved()).records.find(r=>r.id===original.id).startedAt,'');
 assert.equal((await saved()).records.length,recordCount);
 // New completion uses the same validation and does not complete on draft persistence.
 await page.locator('#history-toggle').click();
 assert.equal(await value(),suspended.text);
 await setTimes('2020-02-01T10:15','2020-01-31T23:59');
 await page.locator('#complete').click();
 assert.match(await page.locator('#time-error').textContent(),/Finish must be at or after start/);
 assert.equal((await saved()).records.length,recordCount);
 await setTimes('2020-02-01T10:15','');await page.locator('#complete').click();
 assert.equal((await saved()).records[0].startedAt,'2020-02-01T10:15');
 assert.equal((await saved()).records[0].completedAt,'');
 // A legacy record with no time fields can be edited, without creating a copy.
 await page.locator('#back-history').click();
 await page.locator('#history-list .record').filter({hasText:'My free workout'}).click();
 await page.locator('#edit-again').click();
 assert.equal(await page.locator('#started-at').inputValue(),'');
 assert.equal(await page.locator('#completed-at').inputValue(),'');
 await setTimes('2019-05-01T08:00','2019-05-01T09:00');await page.locator('#complete').click();
 assert.equal((await saved()).records.filter(r=>r.id==='free-title').length,1);
 assert.equal((await saved()).records.find(r=>r.id==='free-title').startedAt,'2019-05-01T08:00');
 // Editing a historical yearless legacy header must not move it to this year.
 await page.locator('#back-history').click();
 await page.locator('#history-list .record').filter({hasText:'legacy date'}).click();
 await page.locator('#edit-again').click();await setTimes('2018-05-02T07:15','2018-05-02T08:30');
 await page.locator('#complete').click();
 assert.equal((await saved()).records.find(r=>r.id==='legacy-date').date,'2018-05-02');
 // Demo records become same-ID local overrides, never duplicate fixture entries.
 await page.locator('#back-history').click();
 const historyCount=await page.locator('#history-list .record').count();
 await page.locator('#history-list .record').filter({hasText:'27 Sept 2026'}).click();
 await page.locator('#edit-again').click();
 await type('27.09.2026 revised demo\nприсідання 70-10');
 await page.locator('#complete').click();
 assert.equal((await saved()).records.filter(r=>r.id==='sample-lower').length,1);
 await page.reload();await page.locator('#history-toggle').click();
 assert.equal(await page.locator('#history-list .record').count(),historyCount);
 assert.equal(await page.locator('#history-list .record').filter({hasText:'revised demo'}).count(),1);
 // Existing copy-as-draft states remain readable and preserve old record bytes.
 const legacyCopy={...seed,draft:{text:'legacy draft copy',copy:true}};
 await page.evaluate(({key,legacyCopy})=>localStorage.setItem(key,JSON.stringify(legacyCopy)),{key,legacyCopy});
 await page.reload();assert.equal(await value(),'legacy draft copy');
 await type('legacy draft copy changed');
 assert.deepEqual((await saved()).records,seed.records.map(r=>({...r,sample:false})));
 // Read failures must not destroy the existing bytes on the next keystroke.
 const corrupt='{"draft":broken';
 await page.evaluate(({key,corrupt})=>localStorage.setItem(key,corrupt),{key,corrupt});await page.reload();
 await type('my memory-only workout');
 assert.equal(await page.evaluate(key=>localStorage.getItem(key),key),corrupt);
 assert.match(await page.locator('#storage-notice').textContent(),/left untouched/);
 // Storage unavailable is usable, explicit, and never implies persistence.
 const unavailable=await context.newPage();
 await unavailable.addInitScript(()=>Object.defineProperty(window,'localStorage',{get(){throw new DOMException('Unavailable','SecurityError');}}));
 await unavailable.goto(url);await unavailable.locator('#editor').fill('offline memory note');
 assert.equal(await unavailable.locator('#save-status').textContent(),'Memory only');
 await unavailable.close();
 // Direct file navigation works with no server, dependency, or fetch required.
 await context.setOffline(true);
 const file=await context.newPage();await file.goto(pathToFileURL(path.join(__dirname,'index.html')).href);
 await file.locator('#editor').fill('03.10.2026 upper\n');await file.locator('#editor').focus();
 assert.match(await file.locator('#ghost').textContent(),/^жим в нахилі сміт/);
 await file.setViewportSize({width:320,height:844});
 await file.screenshot({path:path.join(artifacts,'djym-demo-320.png'),fullPage:true});
 await file.locator('#editor').fill('03.10.2026 upper\nжим в нахилі сміт ');
 assert.equal(await file.locator('#ghost').textContent(),'60-10 -9 50-11 -10');
 const wrapped=await file.locator('#ghost').evaluate(el=>{const range=document.createRange();range.selectNodeContents(el);return range.getClientRects().length;});
 assert.ok(wrapped>=2,'long ghost wraps inline at 320px');
 await file.screenshot({path:path.join(artifacts,'djym-wrapped-ghost-320.png'),fullPage:true});
 await file.locator('#editor').press('Tab');
 assert.equal(await file.locator('#editor').inputValue(),'03.10.2026 upper\nжим в нахилі сміт 60-10 -9 50-11 -10');
 await file.setViewportSize({width:1280,height:900});
 await file.screenshot({path:path.join(artifacts,'djym-desktop.png'),fullPage:true});
 await file.close();
 assert.deepEqual(errors,[]);assert.equal(externalRequests,0);
 await browser.close();
 console.log('PASS: normalized title matching, unknown titles, scoped history, no pre-accept mutation, Tab/tap/right-swipe, gesture guards, selection/IME/editing, persistence/migration, explicit completion, local historical timestamps/range validation, same-ID editing/cancel/refresh/suspended drafts/demo overrides, 320–430px mirror/overflow, storage failure, direct file/offline.');
 console.log('Screenshots: '+artifacts);
})().catch(error=>{console.error(error);process.exit(1);});
