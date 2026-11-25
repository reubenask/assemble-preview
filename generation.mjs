export const modelNames={kling:'Kling',seedance:'Seedance',minimax:'MiniMax',veo:'Google Veo'};
let backend='',token='';
export function setBackend(url,access) {
  const value=url.trim();
  if(value){
    const parsed=new URL(value);
    if(parsed.protocol!=='https:'||parsed.username||parsed.password||parsed.search||parsed.hash)
      throw Error('Enter an HTTPS backend URL.');
    if(!access.trim())throw Error('Enter the backend access token.');
    backend=parsed.href.replace(/\/$/,'');token=access.trim();
  }else{backend='';token='';}
}
export function hasBackend(){
  return Boolean(backend)||(['localhost','127.0.0.1'].includes(location.hostname)&&location.protocol!=='file:');
}
export async function api(path,body,binary=false) {
  if(!hasBackend())throw Error('Connect your backend in the workspace, or open the local server.');
  const headers=backend?{Authorization:'Bearer '+token}:{};
  const options={headers,credentials:'omit',redirect:'error',cache:'no-store'};
  if(body){options.method='POST';options.body=JSON.stringify(body);headers['Content-Type']='application/json';headers['X-Assemble-Request']='manual';}
  const response=await fetch((backend||'')+'/api/'+path,options);
  if(!response.ok){
    const error=await response.json().catch(()=>({}));
    throw Error(error.error||'Backend returned HTTP '+response.status+'.');
  }
  return binary?response.blob():response.json();
}
export async function generateAsset(input,onStatus,pending){
  if(!pending.id)pending.id=(await api('media',{...input,request:pending.request})).id;
  for(let i=0;i<480;i++){
    const result=await api('media/'+pending.id);
    if(result.state==='ready'){
      const blob=await api('media/'+pending.id+'/file',null,true);
      if(blob.size>55*1024*1024) throw Error('Generated clip exceeds 55 MB.');
      return new Promise((resolve,reject)=>{const r=new FileReader();r.onload=()=>resolve(r.result);r.onerror=()=>reject(Error('Could not read generated media.'));r.readAsDataURL(blob);});
    }
    onStatus(result.state);
    await new Promise(resolve=>setTimeout(resolve,3000));
  }
  throw Error('Job is still processing. Retry to check the same job.');
}
const videoCache=new Map(),audioCache=new Map();
export function clearMediaCache(){
  for(const v of videoCache.values()){v.pause();v.removeAttribute('src');v.load();}
  videoCache.clear();audioCache.clear();
}
export function videoFor(data) {
  if(!data)return null;
  if(!videoCache.has(data)){
    const v=document.createElement('video');v.muted=true;v.playsInline=true;v.preload='auto';v.src=data;
    videoCache.set(data,v);
  }
  return videoCache.get(data);
}
export async function readyVideo(data) {
  const v=videoFor(data);
  if(v.readyState>=2)return v;
  return new Promise((resolve,reject)=>{
    let timeout;
    const finish=ok=>{clearTimeout(timeout);v.removeEventListener('loadeddata',yes);v.removeEventListener('error',no);ok?resolve(v):reject(Error('The generated clip could not be decoded.'));};
    const yes=()=>finish(true),no=()=>finish(false);
    v.addEventListener('loadeddata',yes);v.addEventListener('error',no);timeout=setTimeout(no,20000);
  });
}
export function stopVideos(){for(const v of videoCache.values())v.pause();}
export async function decodeVoice(ctx,src) {
  if(!audioCache.has(src)){
    const raw=Uint8Array.from(atob(src.slice(src.indexOf(',')+1)),c=>c.charCodeAt(0));
    audioCache.set(src,await ctx.decodeAudioData(raw.buffer));
  }
  return audioCache.get(src);
}


export async function sampleClip(data){
  const v=await readyVideo(data);v.pause();
  const canvas=document.createElement('canvas');canvas.width=512;canvas.height=Math.max(1,Math.round(512*v.videoHeight/v.videoWidth));
  const g=canvas.getContext('2d'),out=[];
  for(const fraction of [0,.25,.5,.75,1]){
    const t=Math.max(0,(v.duration-.06)*fraction);
    if(Math.abs(v.currentTime-t)>.002){
      await new Promise((resolve,reject)=>{
        const timer=setTimeout(()=>{v.removeEventListener('seeked',finish);reject(Error('Clip frame sampling timed out.'));},10000);
        function finish(){clearTimeout(timer);resolve();}
        v.addEventListener('seeked',finish,{once:true});v.currentTime=t;
      });
    }
    g.drawImage(v,0,0,canvas.width,canvas.height);out.push({image:canvas.toDataURL('image/jpeg',.82),source:'clip sample',text:''});
  }
  v.currentTime=0;return out;
}
