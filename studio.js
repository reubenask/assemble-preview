import {readScene,compileScene,contain,frameImage} from './scene.mjs';
import {mountSceneEditor} from './scene-editor.mjs';
import {modelNames,setBackend,hasBackend,api,generateAsset,videoFor,readyVideo,stopVideos,decodeVoice,clearMediaCache,sampleClip} from './generation.mjs';
let mediaReady=false,generating=false,stopAfter=false,exportPreparing=false,activeView='illustration',playingVideo=null;
let soundContext=null,voiceSource=null,voiceKey='',recordDestination=null;
const preparedScenes=new WeakMap(),voiceBuffers=new Map(),mediaPending=new WeakMap();
// Local manual studio. Page text is extracted verbatim, never treated as AI-generated instructions.
const el=id=>document.getElementById(id);
// The landing page is in the initial HTML, before any scripts execute.
const root=el('studio');
const opener=document.createElement('button');opener.id='openStudio';opener.innerHTML='<svg class="upload-symbol" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 16V3m-5 5 5-5 5 5M4 15v5a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-5"/></svg><span>Upload manual<small>PDF or pictures</small></span>';opener.setAttribute('aria-label','Upload manual — PDF or pictures');opener.title='Upload a PDF or pictures of your manual';document.body.append(opener);
function showWorkspace(){el('landingView').hidden=true;el('workspaceView').hidden=false;el('saveProject').hidden=false;document.body.classList.remove('assemble-home');root.scrollTop=0}
function showHome(){if(recording)return;stopGuide();studioVisible(true);el('landingView').hidden=false;el('workspaceView').hidden=true;el('saveProject').hidden=true;document.body.classList.add('assemble-home');root.scrollTop=0}
function uploadFromHome(){if(recording||busy||generating)return;showWorkspace();stopGuide();el('guideView').hidden=true;el('editorView').hidden=false;el('chooseFiles').focus({preventScroll:true});}
for(const id of ['heroUpload','headerUpload','footerUpload'])el(id).onclick=uploadFromHome;
el('brandHome').onclick=showHome;el('backHome').onclick=showHome;
el('howItWorks').onclick=()=>{showHome();el('howSection').scrollIntoView({behavior:'smooth'})};
el('howLink').onclick=e=>{e.preventDefault();el('howSection').scrollIntoView({behavior:'smooth'})};
el('heroDemo').onclick=()=>el('showDemo').click();el('heroDone').onclick=()=>{el('showDemo').click();window.dispatchEvent(new CustomEvent('flatpack-model',{detail:{kind:'lack',dims:[55,55,45]}}));window.dispatchEvent(new CustomEvent('flatpack-replayphase',{detail:{phase:1}}))};

let steps=[],selected=0,busy=false,guidePlaying=false,guideTime=0,prevFrame=performance.now(),lastSpoken=-1,recording=null,recordCancelled=false,guidedStarted=false,guidedIndex=0,playbackSpeed=1,actionIndex=0,actionParts=[],completedSteps=new Set();
let sourcePages=[],analysisNeedsAnswers=false,analysisBusy=false,aiConfigured=false,clarificationHistory='',helpTurns=[];
let outputMode='animated';
function applyOutputMode(mode){
 outputMode=['video','both'].includes(mode)?mode:'animated';
 for(const radio of root.querySelectorAll('input[name="outputMode"]'))radio.checked=radio.value===outputMode;
 el('videoSettings').hidden=outputMode==='animated';
 el('outputDescription').textContent=outputMode==='animated'?'Animate an outlined part or compare two source panels.':'Generate each step from the same source frames. Choose a different model to compare its result.';
 el('previewGuide').textContent='Open step-by-step guide →';
}
for(const radio of root.querySelectorAll('input[name="outputMode"]'))radio.onchange=()=>applyOutputMode(radio.value);
const imgCache=new Map();const uid=()=>crypto.randomUUID?crypto.randomUUID():`${Date.now()}-${Math.random()}`;
function status(text){el('studioStatus').textContent=text}function title(){return el('projectTitle').value.trim()||'My instruction guide'}
function stopGuide(){stopVoices();stopVideos();playingVideo=null;guidePlaying=false;el('guidePlay').textContent='Play';window.speechSynthesis?.cancel();lastSpoken=-1}
function studioVisible(yes){root.hidden=!yes;document.body.classList.remove('manual-linked');document.body.classList.toggle('manual-studio-open',yes);for(const node of document.querySelectorAll('.intro,.controls,.scene-caption,.brand,.orbit-hint,#scene'))node.inert=yes;if(yes){window.dispatchEvent(new CustomEvent('flatpack-pause'))}else stopGuide()}
opener.onclick=()=>{if(recording||busy||generating)return;showWorkspace();stopGuide();studioVisible(true);el('guideView').hidden=true;el('editorView').hidden=false;el('dropZone').scrollIntoView({block:'center'});el('manualFiles').click()};el('showDemo').onclick=()=>{studioVisible(false)};
function imageOf(src){if(!imgCache.has(src)){const im=new Image();im.src=src;imgCache.set(src,im)}return imgCache.get(src)}
async function loadImage(src){const im=imageOf(src);if(!im.complete||!im.naturalWidth)await im.decode();return im;}
function readData(file){return new Promise((resolve,reject)=>{const r=new FileReader();r.onload=()=>resolve(r.result);r.onerror=()=>reject(new Error('Unable to read file.'));r.readAsDataURL(file)})}
function addStep(image,source,text=''){sourcePages.push({image,source,text:text.slice(0,12000)});steps.push({id:uid(),image,source,title:`Step ${steps.length+1}`,text:text.slice(0,4000),duration:8,evidence:[sourcePages.length],reviewed:false,focus:null,phase:0});imageOf(image)}
function compactImage(im){const c=document.createElement('canvas'),scale=Math.min(1,1800/Math.max(im.width,im.height));c.width=Math.round(im.width*scale);c.height=Math.round(im.height*scale);const g=c.getContext('2d');g.fillStyle='white';g.fillRect(0,0,c.width,c.height);g.drawImage(im,0,0,c.width,c.height);return c.toDataURL('image/jpeg',.88)}
async function importFiles(files){if(busy||analysisBusy||generating)return;busy=true;const errors=[];let added=0;el('chooseFiles').disabled=true;el('openStudio').disabled=true;el('takePhoto').disabled=true;try{for(const file of files){if(sourcePages.length>=60){errors.push('Project limit reached: 60 source pages.');break}if(file.size>40*1024*1024){errors.push(`${file.name}: exceeds the 40 MB file limit.`);continue}status(`Reading ${file.name}…`);try{if(file.type==='application/pdf'||/\.pdf$/i.test(file.name)){if(!window.pdfjsLib)throw new Error('PDF reader unavailable. Reload the app.');const doc=await pdfjsLib.getDocument({data:new Uint8Array(await file.arrayBuffer()),isEvalSupported:false,useSystemFonts:true}).promise;try{const count=Math.min(doc.numPages,60-sourcePages.length);for(let n=1;n<=count;n++){status(`Rendering ${file.name} · page ${n} of ${count}…`);const page=await doc.getPage(n),v=page.getViewport({scale:1}),viewport=page.getViewport({scale:Math.min(2,1600/Math.max(v.width,v.height))}),canvas=document.createElement('canvas');canvas.width=viewport.width;canvas.height=viewport.height;await page.render({canvasContext:canvas.getContext('2d'),viewport}).promise;const tc=await page.getTextContent();let text='';for(const item of tc.items)text+=item.str+(item.hasEOL?'\n':' ');addStep(canvas.toDataURL('image/jpeg',.88),`${file.name} · page ${n}`,text.trim());added++;page.cleanup()}if(count<doc.numPages)errors.push(`${file.name}: imported ${count} of ${doc.numPages} pages due to the project limit.`)}finally{await doc.destroy()}}else if(file.type.startsWith('image/')){const im=await loadImage(await readData(file));addStep(compactImage(im),file.name);added++}else errors.push(`${file.name}: use PDF, JPG, PNG or WebP.`)}catch(e){errors.push(`${file.name}: ${e.name==='PasswordException'?'Password-protected PDF. Export an unlocked copy first.':e.message}`)}}selected=Math.max(0,steps.length-added);render();status(`${added} page${added===1?'':'s'} added. ${added?'Source pages imported. Use AI analysis to draft actions, or edit their instructions manually.':''}${errors.length?'\n'+errors.join('\n'):''}`)}finally{busy=false;el('chooseFiles').disabled=false;el('openStudio').disabled=false;el('takePhoto').disabled=false;el('manualFiles').value='';el('cameraFile').value=''}if(added){guidedStarted=false;completedSteps.clear();if(el('autoAnalyze').checked)await analyzeManual();}}
el('chooseFiles').onclick=()=>el('manualFiles').click();el('takePhoto').onclick=()=>el('cameraFile').click();el('manualFiles').onchange=e=>importFiles([...e.target.files]);el('cameraFile').onchange=e=>importFiles([...e.target.files]);const zone=el('dropZone');zone.ondragover=e=>{e.preventDefault();zone.classList.add('dragover')};zone.ondragleave=()=>zone.classList.remove('dragover');zone.ondrop=e=>{e.preventDefault();zone.classList.remove('dragover');importFiles([...e.dataTransfer.files])};
function renderList(){el('stepList').replaceChildren();steps.forEach((s,i)=>{const b=document.createElement('button');b.className='step-item'+(i===selected?' active':'');const im=document.createElement('img');im.src=s.image;im.alt='';const span=document.createElement('span'),name=document.createElement('b'),meta=document.createElement('small');name.textContent=s.title||`Step ${i+1}`;meta.textContent=`${i+1} · ${s.reviewed?'Reviewed':'Draft'} · ${s.duration}s`;span.append(name,meta);b.append(im,span);b.onclick=()=>{selected=i;render()};el('stepList').append(b)});if(!steps.length)el('stepList').innerHTML='<p class="empty-steps">Your imported manual pages will appear here, in order.</p>';el('stepCount').textContent=steps.length;el('reviewProgress').textContent=steps.length?`${steps.filter(s=>s.reviewed).length} of ${steps.length} steps reviewed · ${totalDuration()} seconds`:'Add a manual to begin.'}
function render(){renderList();const editor=el('stepEditor');if(!steps.length){editor.innerHTML='<div class="editor-placeholder">Your manual is the starting point.<p class="studio-note">Upload pages above, then refine each step here.</p></div>';return}const s=steps[selected];editor.innerHTML=`<div class="step-toolbar"><button id="moveUp">← Earlier</button><button id="moveDown">Later →</button><button id="duplicateStep">Duplicate page</button><button id="deleteStep">Remove step</button><button id="rotatePage">Rotate photo ↻</button></div><div class="editor-grid"><div><div class="page-frame"><canvas id="pageCanvas" aria-label="Manual page: drag to select a focus region"></canvas></div><p class="focus-note">Drag to highlight a detail on the source page. Open Illustration and source frames below to specify motion.</p><button class="studio-btn" id="clearFocus">Clear focus box</button><p class="studio-note" id="sourceLabel"></p></div><div><div class="studio-field"><label for="stepName">STEP TITLE</label><input id="stepName" maxlength="100"></div><div class="studio-field"><label for="stepText">INSTRUCTIONS · REVIEW BEFORE PLAYBACK</label><textarea id="stepText" maxlength="4000" placeholder="Describe what to do in this step. Include the parts, orientation and important cautions."></textarea></div><p class="studio-note">Copied PDF text may include headers or several actions. Edit it into one clear instruction. Keep each instruction under 650 characters; split longer actions. AI drafts must be checked against the cited pages. You can also write or correct the instructions yourself.</p><div class="studio-field"><label for="stepDuration">SECONDS ON SCREEN</label><input id="stepDuration" type="number" min="3" max="180"></div><label class="step-reviewed"><input id="stepReviewed" type="checkbox"> I reviewed this step against the manual</label></div></div>`;
el('stepName').value=s.title;el('stepText').value=s.text;el('stepDuration').value=s.duration;el('stepReviewed').checked=s.reviewed;el('sourceLabel').textContent=s.source;
for(const [id,key] of [['stepName','title'],['stepText','text']])el(id).oninput=e=>{s[key]=e.target.value;invalidateMedia(s);completedSteps.delete(s.id);s.reviewed=false;el('stepReviewed').checked=false;renderList()};el('stepDuration').onchange=e=>{s.duration=Math.max(3,Math.min(180,Number(e.target.value)||8));e.target.value=s.duration;renderList()};el('stepReviewed').onchange=e=>{if(e.target.checked&&(!s.text.trim()||s.text.length>650)){e.target.checked=false;status('Add an instruction of 650 characters or fewer before marking this step reviewed. Duplicate the page to split longer actions.');return}s.reviewed=e.target.checked;renderList()};el('moveUp').disabled=selected===0;el('moveDown').disabled=selected===steps.length-1;el('moveUp').onclick=()=>{[steps[selected-1],steps[selected]]=[steps[selected],steps[selected-1]];selected--;render()};el('moveDown').onclick=()=>{[steps[selected+1],steps[selected]]=[steps[selected],steps[selected+1]];selected++;render()};el('duplicateStep').onclick=()=>{if(steps.length>=60)return status('Maximum 60 steps per project.');steps.splice(selected+1,0,{...s,id:uid(),title:s.title+' · next action',focus:null,scene:null,clips:{},voice:null,reviewed:false});selected++;render()};el('deleteStep').onclick=()=>{steps.splice(selected,1);selected=Math.max(0,Math.min(selected,steps.length-1));render()};el('clearFocus').onclick=()=>{s.focus=null;paintPage()};el('rotatePage').onclick=async()=>{const im=await loadImage(s.image),c=document.createElement('canvas');c.width=im.height;c.height=im.width;const g=c.getContext('2d');g.translate(c.width,0);g.rotate(Math.PI/2);g.drawImage(im,0,0);rotateSource(s,c.toDataURL('image/jpeg',.9));render()};paintPage();const pc=el('pageCanvas');let start=null;const point=e=>{const r=pc.getBoundingClientRect();return{x:Math.max(0,Math.min(1,(e.clientX-r.left)/r.width)),y:Math.max(0,Math.min(1,(e.clientY-r.top)/r.height))}};pc.onpointerdown=e=>{start=point(e);pc.setPointerCapture(e.pointerId)};pc.onpointermove=e=>{if(!start)return;const p=point(e);s.focus={x:Math.min(p.x,start.x),y:Math.min(p.y,start.y),w:Math.abs(p.x-start.x),h:Math.abs(p.y-start.y)};paintPage()};pc.onpointerup=()=>{start=null;if(s.focus&&(s.focus.w<.03||s.focus.h<.03))s.focus=null;paintPage()};
 mountSceneEditor(editor,s,sourcePages,loadImage,readScene,scene=>{
   s.scene=scene;if(scene){s.evidence=[...new Set([...(s.evidence||[]),scene.start.page,...(scene.end?[scene.end.page]:[])])];s.source=s.evidence.map(n=>'Page '+n).join(', ');}
   invalidateMedia(s);s.reviewed=false;el('stepReviewed').checked=false;renderList();
 });
}
async function paintPage(){const s=steps[selected],c=el('pageCanvas');if(!s||!c)return;const im=await loadImage(s.image);if(c!==el('pageCanvas'))return;c.width=im.width;c.height=im.height;const g=c.getContext('2d');g.drawImage(im,0,0);if(s.focus){const f=s.focus;g.strokeStyle='#d09937';g.lineWidth=Math.max(3,c.width/180);g.fillStyle='#e4b45b30';g.fillRect(f.x*c.width,f.y*c.height,f.w*c.width,f.h*c.height);g.strokeRect(f.x*c.width,f.y*c.height,f.w*c.width,f.h*c.height)}}
function download(blob,name){const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),30000)}function filename(){return title().replace(/[^a-z0-9 -]/gi,'').trim().replace(/\s+/g,'-')||'assembly-guide'}
el('saveProject').onclick=()=>{if(!steps.length)return status('Upload a manual before saving a project.');const file=new Blob([JSON.stringify({format:'assemble-manual-v1',title:title(),outputMode,sourcePages,analysisNeedsAnswers,clarificationHistory,questions:[...el('questionList').children].map(n=>n.textContent),progress:captureProgress(steps,completedSteps,guidedIndex,guidedStarted),videoModel:el('videoModel').value,steps})],{type:'application/json'});if(file.size>400*1024*1024)return status('This project exceeds the 400 MB portable file limit. Export the guide as a video.');download(file,filename()+'.json');status('Project downloaded, including your pages and edits. Open project restores it later.')};el('loadProject').onclick=()=>el('projectFile').click();el('projectFile').onchange=async e=>{const f=e.target.files[0];if(!f)return;try{if(f.size>400*1024*1024)throw new Error('Project exceeds 400 MB.');const p=JSON.parse(await f.text());if(!['assemble-manual-v1','flatpack-manual-v1'].includes(p.format)||!Array.isArray(p.steps)||!p.steps.length||p.steps.length>60)throw new Error('Not a supported Assemble project.');const pageCount=Array.isArray(p.sourcePages)?p.sourcePages.length:p.steps.length;const next=p.steps.map((s,i)=>{if(typeof s.image!=='string'||!/^data:image\/(jpeg|png|webp);base64,/.test(s.image))throw new Error(`Invalid image in step ${i+1}.`);return{scene:readScene(s.scene,Array.isArray(s.evidence)?s.evidence.filter(n=>Number.isInteger(n)&&n>0&&n<=pageCount):[]),clips:restoreClips(s.clips),voice:restoreVoice(s.voice),evidence:Array.isArray(s.evidence)?s.evidence.filter(n=>Number.isInteger(n)&&n>0&&n<=pageCount):[],check:String(s.check||'').slice(0,650),materials:Array.isArray(s.materials)?s.materials.map(String).slice(0,30):[],warnings:Array.isArray(s.warnings)?s.warnings.map(String).slice(0,30):[],id:uid(),image:s.image,title:String(s.title||`Step ${i+1}`).slice(0,100),source:String(s.source||'Imported project').slice(0,300),text:String(s.text||'').slice(0,4000),duration:Math.max(3,Math.min(180,Number(s.duration)||8)),reviewed:!!s.reviewed&&!!String(s.text||'').trim(),phase:Math.max(0,Math.min(2,Number(s.phase)||0)),focus:s.focus&&['x','y','w','h'].every(k=>Number.isFinite(s.focus[k])&&s.focus[k]>=0&&s.focus[k]<=1)&&s.focus.x+s.focus.w<=1.001&&s.focus.y+s.focus.h<=1.001?s.focus:null}});await Promise.all(next.map(s=>loadImage(s.image)));showWorkspace();el('guideView').hidden=true;el('editorView').hidden=false;stopGuide();clearMediaCache();voiceBuffers.clear();steps=next;sourcePages=Array.isArray(p.sourcePages)&&p.sourcePages.length<=60&&p.sourcePages.every(x=>typeof x.image==='string'&&/^data:image\/(jpeg|png|webp);base64,/.test(x.image))?p.sourcePages.map(x=>({image:x.image,source:String(x.source||'').slice(0,300),text:String(x.text||'').slice(0,12000)})):next.map(x=>({image:x.image,source:x.source,text:x.text}));analysisNeedsAnswers=!!p.analysisNeedsAnswers;clarificationHistory=String(p.clarificationHistory||'').slice(0,8000);selected=0;const restored=restoreProgress(p.progress,steps);guidedStarted=restored.started;guidedIndex=restored.index;completedSteps=restored.completed;el('questionList').replaceChildren();for(const q of (Array.isArray(p.questions)?p.questions:[]).slice(0,30)){const li=document.createElement('li');li.textContent=String(q).slice(0,650);el('questionList').append(li);}el('analysisQuestions').hidden=!analysisNeedsAnswers;el('analysisStatus').textContent=analysisNeedsAnswers?'This project has unresolved analysis. Answer its questions or retry analysis.':'';el('projectTitle').value=String(p.title||'My instruction guide').slice(0,100);applyOutputMode(p.outputMode);if(Object.hasOwn(modelNames,p.videoModel))el('videoModel').value=p.videoModel;render();status('Project restored. Existing pages in the editor were replaced.')}catch(err){status(err.message)}e.target.value=''};
el('downloadSteps').onclick=()=>{if(!steps.length)return status('Add a manual first.');const text=title()+'\n\n'+steps.map((s,i)=>`${i+1}. ${s.title} [${s.reviewed?'reviewed':'draft'}]\n${s.text||'[Instruction not added]'}\nSource: ${s.source}`).join('\n\n');download(new Blob([text],{type:'text/plain'}),filename()+'.txt')};
function totalDuration(){return steps.reduce((n,s)=>n+s.duration,0)}function atTime(t){let offset=0;for(let i=0;i<steps.length;i++){if(t<offset+steps[i].duration||i===steps.length-1)return{i,step:steps[i],local:Math.max(0,Math.min(steps[i].duration,t-offset)),offset};offset+=steps[i].duration}return null}
function wrapped(g,text,x,y,maxWidth,lineHeight,maxLines){const words=text.split(/\s+/);let line='',lines=[];for(const word of words){if(g.measureText(line+word).width>maxWidth&&line){lines.push(line.trim());line=''}line+=word+' '}if(line)lines.push(line.trim());for(let i=0;i<Math.min(lines.length,maxLines);i++){let value=lines[i];if(i===maxLines-1&&lines.length>maxLines)value=value.slice(0,-3)+'…';g.fillText(value,x,y+i*lineHeight)}}
function drawGuide(){const state=atTime(guideTime);if(!state)return;const {i,step:s,local}=state,c=el('guideCanvas'),g=c.getContext('2d'),im=imageOf(s.image);g.fillStyle='#101725';g.fillRect(0,0,1280,720);g.fillStyle='#e6be80';g.font='500 15px Arial';g.fillText('ASSEMBLE / '+title().toUpperCase().slice(0,70),36,40);g.fillStyle='#94a4bc';g.textAlign='right';g.fillText(`STEP ${i+1} / ${steps.length}${s.reviewed?'':' · DRAFT'}`,1244,40);g.textAlign='left';const box={x:36,y:65,w:790,h:595};g.fillStyle='#eeeae2';g.fillRect(box.x,box.y,box.w,box.h);drawVisual(g,box,s,local,im);g.fillStyle='#e6be80';g.font='bold 62px Arial';g.fillText(String(i+1).padStart(2,'0'),866,130);g.fillStyle='#f3f3ef';g.font='bold 26px Arial';wrapped(g,s.title,866,181,375,34,3);g.font='20px Arial';g.fillStyle='#c3ccdb';wrapped(g,s.text||'No instruction added. Return to Edit steps to describe this action.',866,298,365,29,11);g.font='12px Arial';g.fillStyle='#8b9bb3';wrapped(g,s.source,866,646,360,17,2);g.fillStyle='#303c50';g.fillRect(36,689,1208,3);g.fillStyle='#e6be80';g.fillRect(36,689,1208*guideTime/totalDuration(),3);el('guideTimeline').value=guideTime;el('guideTime').textContent=`${Math.floor(guideTime)} / ${totalDuration()}s`;syncVoice(s,local,i);}

el('previewGuide').onclick=async()=>{if(analysisBusy||analysisNeedsAnswers)return status('Finish the manual questions and analysis before starting the guide.');if(!steps.length)return status('Upload a PDF or photo to create a guide.');stopGuide();await Promise.all([...new Set([...steps.map(s=>s.image),...sourcePages.map(p=>p.image)])].map(loadImage));selectGuideView();if(!guidedStarted){guidedIndex=0;completedSteps.clear();guidedStarted=true}guidedIndex=Math.min(guidedIndex,steps.length-1);completedSteps=new Set([...completedSteps].filter(id=>steps.some(s=>s.id===id)));guideTime=stepBounds(guidedIndex).start;playbackSpeed=1;el('guidedMode').checked=true;el('editorView').hidden=true;el('guideView').hidden=false;el('guideTimeline').max=totalDuration();el('draftBadge').textContent=steps.every(s=>s.reviewed)?'ALL STEPS REVIEWED':'DRAFT · REVIEW BEFORE EXPORT';refreshCoach();drawGuide()};el('backEditor').onclick=()=>{if(recording)return;stopGuide();el('guideView').hidden=true;el('editorView').hidden=false};el('guidePlay').onclick=()=>{if(recording)return;if(guidePlaying)stopGuide();else{wakeAudio();if(isGuided()){const bounds=stepBounds(guidedIndex);if(guideTime>=bounds.end-.01)guideTime=bounds.start}else if(guideTime>=totalDuration())guideTime=0;guidePlaying=true;el('guidePlay').textContent='Pause'}};
el('guideTimeline').oninput=e=>{if(recording)return;stopGuide();guideTime=Number(e.target.value);if(isGuided()){const b=stepBounds(guidedIndex);guideTime=Math.max(b.start,Math.min(b.end-.001,guideTime))}drawGuide()};
el('guidePrev').onclick=()=>{if(recording)return;if(isGuided()){goToGuidedStep(Math.max(0,guidedIndex-1));return}stopGuide();const a=atTime(guideTime);guideTime=a.local>.5?a.offset:Math.max(0,a.offset-(steps[a.i-1]?.duration||0));drawGuide()};
el('guideNext').onclick=()=>{if(recording)return;if(isGuided()){el('coachPrompt').textContent='Take your time. Use “I’m done” when you have completed this step.';return}stopGuide();const a=atTime(guideTime);guideTime=Math.min(totalDuration(),a.offset+a.step.duration);drawGuide()};
el('narrate').onchange=()=>{stopVoices();lastSpoken=-1;wakeAudio();window.speechSynthesis?.cancel()};
function setRecordingUI(value){for(const id of ['guidePlay','guidePrev','guideNext','guideTimeline','backEditor','exportVideo','narrate','voiceOnly','showDemo','saveProject','loadProject','headerUpload','brandHome','howItWorks','openStudio','guidedMode','confirmStep','replayStep','needHelp','smallActions','slowReplay','showSource','editCurrentStep','playVariant'])el(id).disabled=value;el('cancelExport').hidden=!value}
el('exportVideo').onclick=exportGuide;
el('cancelExport').onclick=()=>{recordCancelled=true;if(recording?.state==='recording')recording.stop();};
document.addEventListener('visibilitychange',()=>{if(document.hidden&&(recording||exportPreparing)){recordCancelled=true;if(recording?.state==='recording')recording.stop();}});
function isGuided(){return el('guidedMode').checked&&!recording}
function stepBounds(index){const start=steps.slice(0,index).reduce((n,s)=>n+s.duration,0);return{start,end:start+steps[index].duration}}
function refreshCoach(){if(!steps.length)return;const guided=el('guidedMode').checked,s=steps[guidedIndex],b=stepBounds(guidedIndex);el('coach').hidden=!guided;el('guideNext').hidden=guided;el('guideTimeline').min=guided?b.start:0;el('guideTimeline').max=guided?b.end-.001:totalDuration();el('coachProgress').textContent=`STEP ${guidedIndex+1} OF ${steps.length}`;el('coachTitle').textContent=s.title;el('coachInstruction').textContent=s.text||'This step has no instructions yet. Add them in the editor before starting.';refreshEvidence(s);el('coachCompletion').textContent=`${completedSteps.size} / ${steps.length} completed`;const done=completedSteps.size===steps.length&&guidedIndex===steps.length-1;el('confirmStep').textContent=done?'All steps completed ✓':guidedIndex===steps.length-1?'I’m done — finish guide ✓':'I’m done — next step →';el('confirmStep').disabled=done||!s.text.trim();el('coachPrompt').textContent=done?'You’ve completed every step. You can revisit or replay any step whenever you need.':'Follow the instruction at your own pace. When you’re done, shall we move on?';el('stepHelp').hidden=true;el('needHelp').setAttribute('aria-expanded','false');el('actionReader').hidden=true;el('sourceReader').hidden=true}
function goToGuidedStep(index){stopGuide();guidedIndex=index;guideTime=stepBounds(index).start;playbackSpeed=1;refreshCoach();drawGuide()}
function replayCurrent(speed=1){if(recording)return;wakeAudio();stopGuide();guideTime=stepBounds(guidedIndex).start;playbackSpeed=speed;guidePlaying=true;el('guidePlay').textContent='Pause';el('coachPrompt').textContent=speed===.5?'Let’s watch this step slowly. It will pause here when the demonstration ends.':'Watch this step again. We’ll wait here until you’re ready.';drawGuide()}
el('guidedMode').onchange=()=>{stopGuide();guidedIndex=atTime(guideTime)?.i||0;playbackSpeed=1;refreshCoach();drawGuide()};
el('confirmStep').onclick=()=>{if(recording||!steps[guidedIndex].text.trim())return;completedSteps.add(steps[guidedIndex].id);if(guidedIndex<steps.length-1)goToGuidedStep(guidedIndex+1);else{stopGuide();refreshCoach()}};
el('replayStep').onclick=()=>replayCurrent();el('slowReplay').onclick=()=>replayCurrent(.5);
el('needHelp').onclick=()=>{stopGuide();el('stepHelp').hidden=!el('stepHelp').hidden;el('needHelp').setAttribute('aria-expanded',String(!el('stepHelp').hidden));el('coachPrompt').textContent='No rush. Stay on this step and try a different view below.'};
function showAction(){el('actionText').textContent=actionParts[actionIndex];el('actionCount').textContent=`Action ${actionIndex+1} of ${actionParts.length}`;el('actionBack').disabled=actionIndex===0;el('actionNext').disabled=actionIndex===actionParts.length-1}
el('smallActions').onclick=()=>{actionParts=steps[guidedIndex].text.split(/\n+|(?<=[.!?])\s+/).map(s=>s.trim()).filter(Boolean);if(!actionParts.length)actionParts=['Add an instruction for this step in the editor.'];actionIndex=0;el('actionReader').hidden=false;showAction()};el('actionBack').onclick=()=>{actionIndex=Math.max(0,actionIndex-1);showAction()};el('actionNext').onclick=()=>{actionIndex=Math.min(actionParts.length-1,actionIndex+1);showAction()};
el('showSource').onclick=()=>{el('sourceReader').hidden=!el('sourceReader').hidden;const s=steps[guidedIndex],pick=el('sourceChoice');pick.replaceChildren();for(const n of s.evidence||[])if(sourcePages[n-1])pick.add(new Option(sourcePages[n-1].source,n));const show=()=>{el('sourceImage').src=sourcePages[Number(pick.value)-1]?.image||s.image;el('sourceZoom').value=1;el('sourceImage').style.width='100%';};pick.onchange=show;show();};el('sourceZoom').oninput=e=>el('sourceImage').style.width=Number(e.target.value)*100+'%';
el('editCurrentStep').onclick=()=>{stopGuide();selected=guidedIndex;completedSteps.delete(steps[selected].id);el('guideView').hidden=true;el('editorView').hidden=false;render();el('stepEditor').scrollIntoView({behavior:'smooth'})};
function advancePlayback(current,delta,boundary){return Math.min(boundary===null?totalDuration():boundary-.001,current+delta)}
function tick(now){const dt=Math.min((now-prevFrame)/1000,.1);prevFrame=now;if(guidePlaying&&!root.hidden&&!el('guideView').hidden){const boundary=isGuided()?stepBounds(guidedIndex).end:null;guideTime=advancePlayback(guideTime,dt*(recording?1:playbackSpeed),boundary);drawGuide();if(boundary!==null&&guideTime>=boundary-.001){stopGuide();el('coachPrompt').textContent='The demonstration has finished. Try it yourself, replay it, or choose “I’m done” to continue.'}else if(guideTime>=totalDuration()){guidePlaying=false;el('guidePlay').textContent='Play';if(recording?.state==='recording')recording.stop()}}requestAnimationFrame(tick)}requestAnimationFrame(tick);
window.addEventListener('beforeunload',e=>{if(steps.length){e.preventDefault();e.returnValue=''}});render();applyOutputMode('animated');studioVisible(true);showHome();

// Manual-first AI integration. Demo models never generate uploaded-manual steps.
async function checkAI(){
 aiConfigured=false;
 mediaReady=false;
 if(!hasBackend()){el('aiConnection').textContent='Manual editor ready';el('analysisStatus').textContent='To analyze uploads or generate clips, connect a backend below. You can mark and animate diagrams here now.';return false;}
 try{
   const c=await api('config'),select=el('aiProvider'),previous=select.value;select.replaceChildren();
   for(const p of c.providers||[]){const option=new Option(p.label+(p.configured?' · '+p.model:' · offline'),p.id);option.disabled=!p.configured;select.add(option);}
   select.value=(c.providers||[]).find(p=>p.configured&&p.id===previous)?.id||(c.providers||[]).find(p=>p.configured)?.id||'default';
   aiConfigured=!!c.configured;mediaReady=!!c.media?.enabled;
   el('aiConnection').textContent=[aiConfigured?'Manual analysis ready':'Manual analysis offline',mediaReady?'Video ready':'Video offline'].join(' · ');
   el('analysisStatus').textContent=aiConfigured?'Ready to analyze your uploaded pages.':'Add a manual analysis connection on the server. You can also mark diagrams by hand.';
 }catch(e){el('aiConnection').textContent='Backend unavailable';el('analysisStatus').textContent=e.message;}
 return aiConfigured;
}
async function manualRequest(body){return api('manual',{...body,provider:el('aiProvider').value});}
function analysisLock(value){analysisBusy=value;for(const id of ['analyzeManual','answerAnalysis','chooseFiles','takePhoto','loadProject','previewGuide','openStudio','headerUpload','aiProvider'])el(id).disabled=value;el('stepEditor').inert=value;el('stepList').inert=value;}
async function analyzeManual(){
 if(analysisBusy||busy||generating)return;if(!sourcePages.length){el('analysisStatus').textContent='Upload your manual or photos first.';return;}
 analysisLock(true);if(!await checkAI()){analysisLock(false);return;}
 stopGuide();el('analysisStatus').textContent=`Reading ${sourcePages.length} source pages together, checking the product and assembly order…`;
 try{
 const result=await manualRequest({mode:'analyze',pages:sourcePages,clarifications:clarificationHistory});
 el('analysisSummary').textContent=result.product+' — '+result.summary;
 el('questionList').replaceChildren();analysisNeedsAnswers=result.questions.length>0;el('analysisQuestions').hidden=!analysisNeedsAnswers;
 if(analysisNeedsAnswers){for(const q of result.questions){const li=document.createElement('li');li.textContent=q;el('questionList').append(li);}el('analysisStatus').textContent='The manual needs clarification. Answer below or upload the missing pages before starting.';return;}
 steps=result.steps.map((s,i)=>{const source=sourcePages[s.pages[0]-1];return {id:uid(),image:source.image,source:s.pages.map(n=>`Page ${n}: ${sourcePages[n-1].source}`).join(' · '),evidence:s.pages,scene:s.scene||null,title:s.title,text:s.instruction,duration:10,reviewed:false,focus:s.focus,phase:0,check:s.check,materials:s.materials,warnings:s.warnings};});
 selected=0;guidedStarted=false;completedSteps.clear();helpTurns=[];el('projectTitle').value=result.product.slice(0,100);render();el('analysisStatus').textContent=`${steps.length} draft actions created from your manual. Review the source drawings, then open your guide.`;
 }catch(e){el('analysisStatus').textContent=e.message;return;}finally{analysisLock(false);}
 if(!analysisNeedsAnswers&&el('autoGenerate').checked&&outputMode!=='animated')await runGeneration(true);
}
function refreshEvidence(s){
 if(!el('stepEvidence'))return;
 el('stepEvidence').textContent=(s.evidence?.length?'Source pages: '+s.evidence.join(', ')+'. ':'Source: '+s.source+'. ')+(s.materials?.length?'You need: '+s.materials.join(', ')+'. ':'')+(s.warnings?.length?'Caution: '+s.warnings.join(' '):'');
 el('stepCheck').textContent=s.check?'Check before continuing: '+s.check:'';
 el('manualConversation').replaceChildren();helpTurns=[];el('helpStatus').textContent='';
}
el('analyzeManual').onclick=analyzeManual;el('refreshAI').onclick=checkAI;
el('answerAnalysis').onclick=()=>{const answer=el('clarificationAnswer').value.trim();if(!answer){el('analysisStatus').textContent='Please answer the questions or add the missing pages.';return;}clarificationHistory+=(clarificationHistory?'\n':'')+el('questionList').textContent+'\nUser answers: '+answer;el('clarificationAnswer').value='';analyzeManual();};
el('askManual').onclick=async()=>{const question=el('manualQuestion').value.trim();if(!question||!steps.length||recording)return;stopGuide();if(!await checkAI()){el('helpStatus').textContent='Connect an AI provider to ask questions. Replay and original-page tools are available now.';return;}const current=steps[guidedIndex],id=current.id;el('askManual').disabled=true;el('helpStatus').textContent='Checking this step against your manual…';try{const answer=await manualRequest({mode:'help',pages:sourcePages,currentStep:{title:current.title,instruction:current.text,pages:current.evidence||[]},question,conversation:helpTurns});if(steps[guidedIndex]?.id!==id)return;helpTurns.push({role:'user',text:question},{role:'assistant',text:answer.answer});for(const [label,value] of [['You',question],['Guide',answer.answer+'\nSource pages: '+answer.pages.join(', ')+(answer.question?'\n'+answer.question:'')]]){const p=document.createElement('p');p.textContent=label+': '+value;el('manualConversation').append(p);}el('manualQuestion').value='';el('helpStatus').textContent='Still on this step. Continue when you are ready.';}catch(e){el('helpStatus').textContent=e.message;}finally{el('askManual').disabled=false;}};
checkAI();

function captureProgress(items,completed,index,started){return {started:!!started,index:Math.max(0,Math.min(index,items.length-1)),completed:items.flatMap((s,i)=>completed.has(s.id)?[i]:[])};}
function restoreProgress(saved,items){const started=!!saved?.started,index=Number.isInteger(saved?.index)?Math.max(0,Math.min(saved.index,items.length-1)):0;return {started,index,completed:new Set((Array.isArray(saved?.completed)?saved.completed:[]).filter(i=>Number.isInteger(i)&&i>=0&&i<items.length).map(i=>items[i].id))};}


function rotateSource(s,image){
  const old=s.image,page=(s.evidence||[]).find(n=>sourcePages[n-1]?.image===old)||sourcePages.findIndex(p=>p.image===old)+1;
  if(!page){s.image=image;s.scene=null;s.focus=null;s.reviewed=false;invalidateMedia(s);return;}
  sourcePages[page-1].image=image;
  const rect=b=>({x:Math.max(0,1-b.y-b.h),y:b.x,w:b.h,h:b.w}),point=([x,y])=>[1-y,x];
  for(const step of steps){
    if(step!==s&&!step.evidence?.includes(page)&&step.image!==old)continue;
    if(step.image===old){step.image=image;if(step.focus)step.focus=rect(step.focus);}
    const scene=step.scene;
    if(scene?.start.page===page){
      scene.start.box=rect(scene.start.box);
      if(scene.kind==='move'){scene.outline=scene.outline.map(point);scene.to=point(scene.to);}
    }
    if(scene?.end?.page===page)scene.end.box=rect(scene.end.box);
    invalidateMedia(step);step.reviewed=false;completedSteps.delete(step.id);
  }
}
function restoreClips(input) {
  const clips={};
  for(const id of Object.keys(modelNames)){
    const clip=input?.[id];
    if(typeof clip?.data==='string'&&clip.data.startsWith('data:video/mp4;base64,'))
      clips[id]={data:clip.data,approved:clip.approved===true,review:clip.review?{verdict:String(clip.review.verdict).slice(0,20),observation:String(clip.review.observation).slice(0,1000)}:null};
  }
  return clips;
}
function restoreVoice(data){return typeof data==='string'&&data.startsWith('data:audio/wav;base64,')?data:null;}
function invalidateMedia(step){
  step.clips={};step.voice=null;mediaPending.delete(step);preparedScenes.delete(step);
}
function renderer(s){
  if(!s.scene)return null;
  if(!preparedScenes.has(s)){
    const refs=[s.scene.start,s.scene.end].filter(Boolean);
    if(refs.some(p=>!sourcePages[p.page-1]||!imageOf(sourcePages[p.page-1].image).naturalWidth))return null;
    preparedScenes.set(s,compileScene(s.scene,n=>imageOf(sourcePages[n-1].image)));
  }
  return preparedScenes.get(s);
}
function selectGuideView(){
  const pick=el('playVariant'),ids=Object.keys(modelNames).filter(id=>steps.some(s=>s.clips?.[id]));
  pick.replaceChildren(new Option('Source illustration','illustration'));
  for(const id of ids)pick.add(new Option(modelNames[id],id));
  const preferred=el('videoModel').value;
  activeView=outputMode==='animated'?'illustration':ids.includes(preferred)?preferred:ids[0]||'illustration';
  pick.value=activeView;
}
el('playVariant').onchange=e=>{stopGuide();activeView=e.target.value;drawGuide();};
el('connectBackend').onclick=async()=>{
  try{setBackend(el('backendUrl').value,el('backendToken').value);await checkAI();}
  catch(e){el('analysisStatus').textContent=e.message;}
};
function drawVisual(g,box,s,local,image){
  const draw=renderer(s), clip=s.clips?.[activeView];
  const video=clip?videoFor(clip.data):null;
  if(playingVideo!==video){playingVideo?.pause();playingVideo=video;}
  let label;
  if(video){
    label=modelNames[activeView]+(clip.approved?' · reviewed':' · review motion');
    if(video.readyState>=2){
      const t=Math.max(0,Math.min(Math.max(0,video.duration-.045),local));
      if((!guidePlaying&&Math.abs(video.currentTime-t)>.05)||(guidePlaying&&Math.abs(video.currentTime-t)>.25))video.currentTime=t;
      video.playbackRate=recording?1:playbackSpeed;
      if(guidePlaying&&local<video.duration-.06){if(video.paused)video.play().catch(()=>{});}
      else if(!video.paused)video.pause();
      contain(g,video,box);
    }else {label='Loading '+modelNames[activeView]+' clip';video.onloadeddata=()=>{if(!guidePlaying&&!el('guideView').hidden)drawGuide();};}
  }else if(draw){
    draw(g,box,local/s.duration);
    label=s.scene.kind==='move'?'Moving illustration':(local<s.duration/2?'Before · source panel':'After · source panel');
  }else{
    if(image.naturalWidth){
      contain(g,image,box);
      if(s.focus){
        const k=Math.min(box.w/image.width,box.h/image.height),w=image.width*k,h=image.height*k;
        g.strokeStyle='#d2722c';g.lineWidth=3;g.strokeRect(box.x+(box.w-w)/2+w*s.focus.x,box.y+(box.h-h)/2+h*s.focus.y,w*s.focus.w,h*s.focus.h);
      }
    }
    label='Source page · motion unspecified';
  }
  if(!video&&activeView!=='illustration')label=modelNames[activeView]+' clip unavailable · '+label;
  g.fillStyle='#16202b';g.fillRect(box.x,box.y+box.h-29,box.w,29);
  g.fillStyle='white';g.font='15px Arial';g.fillText(label,box.x+12,box.y+box.h-9);
  el('visualType').textContent=label;el('clipAssessment').textContent=clip?.review?'Frame check · '+clip.review.verdict+' — '+clip.review.observation:clip?'Compare the clip with the original drawing before approving.':'';
  el('retryClip').hidden=!clip||!!recording;const approve=el('approveClip');approve.hidden=!clip;approve.disabled=!!clip?.approved||clip?.review?.verdict==='issue'||!!recording;
}
el('approveClip').onclick=()=>{const s=atTime(guideTime)?.step,c=s?.clips?.[activeView];if(c&&c.review?.verdict!=='issue'){c.approved=true;drawGuide();}};
el('retryClip').onclick=async()=>{
  const state=atTime(guideTime);if(!state?.step.clips?.[activeView]||generating)return;
  stopGuide();const s=state.step,id=activeView,old=s.clips[id];selected=state.i;
  el('backEditor').click();applyOutputMode('both');el('videoModel').value=id;render();
  delete s.clips[id];await runGeneration(false);s.clips[id] ||= old;
};
el('videoModel').onchange=()=>{el('mediaStatus').textContent='Selected '+modelNames[el('videoModel').value]+'. Existing clips stay available in the guide.';};
el('makeOne').onclick=()=>runGeneration(false);el('makeAll').onclick=()=>runGeneration(true);
el('stopBatch').onclick=()=>{stopAfter=true;el('stopBatch').disabled=true;};
el('voiceOnly').onclick=()=>runGeneration(true,true);
async function runGeneration(all,voiceOnly=false){
  if(generating||analysisBusy||analysisNeedsAnswers||busy||recording||exportPreparing)return;stopGuide();
  const output=voiceOnly&&!el('guideView').hidden?el('videoStatus'):el('mediaStatus'),model=el('videoModel').value,withVoice=voiceOnly||el('generateVoice').checked;
  if(!steps.length){output.textContent='Upload a manual first.';return;}
  generating=true;stopAfter=false;
  const targets=all?[...steps]:[steps[selected]];let done=0,skipped=0;
  const controls=['exportVideo','voiceOnly','makeOne','makeAll','videoModel','generateVoice','analyzeManual','answerAnalysis','loadProject','chooseFiles','openStudio','takePhoto','headerUpload','previewGuide','connectBackend'];
  for(const id of controls)el(id).disabled=true;
  el('stepEditor').inert=true;el('stepList').inert=true;el('stopBatch').hidden=false;el('stopBatch').disabled=false;
  try{
    await checkAI();if(!mediaReady)throw Error('Connect a backend with FAL_KEY to generate clips. The illustration editor works without a key.');
    for(const s of targets){
      if(stopAfter)break;
      const i=steps.indexOf(s),display='Step '+(i+1)+' · '+modelNames[model];
      if((!voiceOnly&&!s.scene)||!s.text.trim()||s.text.length>650){skipped++;continue;}
      if(!mediaPending.has(s))mediaPending.set(s,{});
      const pending=mediaPending.get(s);
      async function make(key,input){
        const task=pending[key] ||= {request:uid()};
        const report=state=>{output.textContent=display+' · '+(key==='voice'?'narration':'video')+' '+state;};
        report('starting');
        try{const data=await generateAsset(input,report,task);delete pending[key];return data;}
        catch(e){if(/model could not|expired|HTTP 4(00|01|03|04|22)|unexpected generated/i.test(e.message))delete pending[key];throw e;}
      }
      s.clips ||= {};
      if(!voiceOnly){
      if(!s.clips[model]){
        for(const p of [s.scene.start,s.scene.end].filter(Boolean))await loadImage(sourcePages[p.page-1].image);
        const draw=renderer(s);if(!draw)throw Error(display+' needs a new source frame.');
        const data=await make(model,{model,first:frameImage(draw,0),last:frameImage(draw,1),instruction:s.text,
          before:s.scene.before,after:s.scene.after,prior:steps[i-1]?.scene?.after});
        s.clips[model]={data,approved:false};
      }
      const clip=await readyVideo(s.clips[model].data);
      s.duration=Math.max(s.duration,Math.ceil(clip.duration));
      const variant=s.clips[model];
      if(aiConfigured&&!variant.review){
        output.textContent=display+' · checking five video frames against the manual…';
        try{
          const pages=s.evidence.map(n=>sourcePages[n-1]);
          variant.review=await manualRequest({mode:'review-motion',pages,samples:await sampleClip(variant.data),currentStep:{instruction:s.text,before:s.scene.before,after:s.scene.after}});
        }catch(e){variant.review={verdict:'unverified',observation:e.message};}
      }
      }
      if(withVoice){
        if(!s.voice)s.voice=await make('voice',{model:'voice',instruction:s.text});
        const buffer=await bufferFor(s.voice);
        s.duration=Math.max(s.duration,Math.ceil(buffer.duration+.3));
      }
      done++;
    }
    output.textContent=(stopAfter?'Stopped. ':'')+done+' step(s) ready with '+(voiceOnly?'narration':modelNames[model])+'. '+(skipped?skipped+' need a source motion or an instruction. ':'')+'Open the guide to inspect the result.';
  }catch(e){output.textContent=e.message;}
  finally{generating=false;el('stepEditor').inert=false;el('stepList').inert=false;el('stopBatch').hidden=true;for(const id of controls)el(id).disabled=false;render();}
}
function wakeAudio(){
  if(!el('narrate').checked)return;
  soundContext ||= new AudioContext();
  soundContext.resume().catch(()=>{});
}
async function bufferFor(data){
  soundContext ||= new AudioContext();
  if(!voiceBuffers.has(data))voiceBuffers.set(data,await decodeVoice(soundContext,data));
  return voiceBuffers.get(data);
}
function stopVoices(){
  voiceKey='';if(voiceSource){try{voiceSource.stop();}catch{}voiceSource.disconnect();voiceSource=null;}
}
function syncVoice(s,local,index){
  if(!guidePlaying||!el('narrate').checked)return;
  if(!s.voice){
    if(!recording&&lastSpoken!==index&&window.SpeechSynthesisUtterance){
      lastSpoken=index;window.speechSynthesis.cancel();const utterance=new SpeechSynthesisUtterance(s.text);
      utterance.rate=playbackSpeed;window.speechSynthesis.speak(utterance);
    }
    return;
  }
  if(voiceKey===s.id)return;
  stopVoices();voiceKey=s.id;const id=s.id;
  bufferFor(s.voice).then(buffer=>{
    if(voiceKey!==id||!guidePlaying)return;
    const offset=atTime(guideTime)?.local??local;if(offset>=buffer.duration)return;
    const src=soundContext.createBufferSource();src.buffer=buffer;src.playbackRate.value=recording?1:playbackSpeed;
    src.connect(recordDestination||soundContext.destination);voiceSource=src;src.start(0,offset);
  }).catch(()=>{el('videoStatus').textContent='Narration could not be played.';});
}
async function exportGuide(){
  if(recording||exportPreparing)return;
  const info=el('videoStatus'),voiced=el('narrate').checked;
  if(analysisBusy||analysisNeedsAnswers||steps.some(s=>!s.reviewed||!s.text.trim()||s.text.length>650)){info.textContent='Review each step and resolve manual questions before export.';return;}
  if(activeView!=='illustration'&&steps.some(s=>!s.clips?.[activeView]?.approved)){info.textContent='Watch and approve each '+modelNames[activeView]+' clip before exporting this version.';return;}
  if(voiced&&steps.some(s=>!s.voice)){info.textContent='Generate English narration for each step before exporting with voice, or turn off narration for a silent export.';return;}
  const c=el('guideCanvas');
  if(!window.MediaRecorder||!c.captureStream){info.textContent='Video export requires a browser with canvas recording support, such as Chrome.';return;}
  const mime=['video/webm;codecs=vp9,opus','video/webm;codecs=vp8,opus','video/webm','video/mp4'].find(t=>MediaRecorder.isTypeSupported(t));
  if(!mime){info.textContent='No supported video export format in this browser.';return;}
  exportPreparing=true;recordCancelled=false;setRecordingUI(true);stopGuide();
  let stream;
  const cleanup=()=>{
    stream?.getTracks().forEach(t=>t.stop());stopGuide();recordDestination?.disconnect();recordDestination=null;
    recording=null;exportPreparing=false;setRecordingUI(false);guideTime=stepBounds(guidedIndex).start;refreshCoach();drawGuide();
  };
  try{
    info.textContent='Preparing video and sound…';
    if(voiced){
      wakeAudio();await soundContext.resume();recordDestination=soundContext.createMediaStreamDestination();
      for(const s of steps){const buffer=await bufferFor(s.voice);s.duration=Math.max(s.duration,Math.ceil(buffer.duration+.3));}
    }
    if(activeView!=='illustration')for(const s of steps){const v=await readyVideo(s.clips[activeView].data);v.currentTime=0;s.duration=Math.max(s.duration,Math.ceil(v.duration));}
    if(recordCancelled){cleanup();info.textContent='Export cancelled.';return;}
    guideTime=0;drawGuide();stream=c.captureStream(30);
    if(voiced)stream.addTrack(recordDestination.stream.getAudioTracks()[0]);
    const chunks=[];recording=new MediaRecorder(stream,{mimeType:mime,videoBitsPerSecond:4000000});
    recording.ondataavailable=e=>{if(e.data.size)chunks.push(e.data);};
    recording.onerror=()=>{recordCancelled=true;info.textContent='Recording failed.';};
    recording.onstop=()=>{
      cleanup();if(recordCancelled){info.textContent='Export stopped.';return;}
      download(new Blob(chunks,{type:mime}),filename()+(mime.includes('mp4')?'.mp4':'.webm'));
      info.textContent=voiced?'Video downloaded with narration and captions.':'Video downloaded with captions.';
    };
    lastSpoken=-1;recording.start(500);guidePlaying=true;exportPreparing=false;
    info.textContent='Recording your guide. Keep this tab visible.';
  }catch(e){cleanup();info.textContent='Could not export: '+e.message;}
}
