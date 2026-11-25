export function mountSceneEditor(container,step,pages,loadImage,validate,onChange){
  const box=document.createElement('details');box.className='scene-tools';
  box.innerHTML='<summary>Illustration and source frames</summary><p data-info></p><label>Source page <select></select></label><div class="studio-actions"><button data-act="start">Mark before panel</button><button data-act="end">Mark after panel</button><button data-act="outline">Outline a moving part</button><button data-act="target">Set destination</button></div><label>Rotation in the drawing (degrees) <input type="number" min="-720" max="720" value="0"></label><canvas aria-label="Source picture for marking motion and panels"></canvas><p data-status role="status"></p><div class="studio-actions"><button data-act="save" class="studio-btn">Apply illustration</button><button data-act="clear" class="studio-btn">Clear illustration</button></div>';
  container.append(box);
  const query=q=>box.querySelector(q),canvas=query('canvas'),g=canvas.getContext('2d'),pick=query('select'),angle=query('input'),msg=query('[data-status]');
  pages.forEach((p,i)=>pick.add(new Option((i+1)+' · '+p.source,String(i+1))));
  let draft=step.scene?structuredClone(step.scene):null;
  pick.value=String(draft?.start.page||step.evidence?.[0]||Math.max(1,pages.findIndex(p=>p.image===step.image)+1));
  let mode='',anchor=null,drag=null;
  angle.value=draft?.turn||0;
  const full={x:0,y:0,w:1,h:1};
  const page=()=>Number(pick.value);
  function describe(){
    query('[data-info]').textContent=step.scene?.kind==='move'?'The outlined part moves within its source drawing.':step.scene?.kind==='panels'?'Before and after panels are linked. They can also guide a generated video.':'This step currently shows its source page. Mark two panels, or outline a separate part on a plain white background and set its destination.';
  }
  async function paint(){
    const n=page(),im=await loadImage(pages[n-1].image);
    if(!box.isConnected||page()!==n)return;
    canvas.width=im.naturalWidth;canvas.height=im.naturalHeight;g.drawImage(im,0,0);g.lineWidth=Math.max(3,canvas.width/220);
    const rect=(r,color)=>{if(!r)return;g.strokeStyle=color;g.strokeRect(r.x*canvas.width,r.y*canvas.height,r.w*canvas.width,r.h*canvas.height);};
    if(draft?.kind==='panels'){
      if(draft.start?.page===n)rect(draft.start.box,'#14795d');
      if(draft.end?.page===n)rect(draft.end.box,'#cc5329');
    }
    if(draft?.kind==='move'&&draft.start.page===n){
      g.strokeStyle='#14795d';g.beginPath();draft.outline.forEach(([x,y],i)=>i?g.lineTo(x*canvas.width,y*canvas.height):g.moveTo(x*canvas.width,y*canvas.height));g.closePath();g.stroke();
      g.fillStyle='#14795d';for(const [x,y] of draft.outline)g.fillRect(x*canvas.width-3,y*canvas.height-3,6,6);
      if(draft.to){g.fillStyle='#c64510';g.beginPath();g.arc(draft.to[0]*canvas.width,draft.to[1]*canvas.height,canvas.width*.009,0,2*Math.PI);g.fill();}
    }
    rect(drag,'#e17e22');
  }
  box.ontoggle=()=>{if(box.open)paint();};pick.onchange=()=>{mode='';anchor=null;drag=null;paint();};
  function action(name){
    if(name==='save'){
      try{
        if(!draft)throw Error('Mark a pair of panels or outline a moving part first.');
        if(draft.kind==='move')draft.turn=Number(angle.value);
        const scene=validate(draft,pages.map((_,i)=>i+1));
        onChange(scene);describe();msg.textContent='Illustration saved.';
      }catch(e){msg.textContent=e.message;}
      return;
    }
    if(name==='clear'){draft=null;mode='';onChange(null);describe();paint();msg.textContent='Source page selected.';return;}
    mode=name;anchor=null;drag=null;
    if(mode==='outline'){
      draft={kind:'move',start:{page:page(),box:full},outline:[],to:null,turn:0,before:'',after:''};
      msg.textContent='Click around the separate part, then choose Set destination.';paint();
    }else if(mode==='target'){
      if(draft?.kind!=='move'||draft.outline.length<3){mode='';msg.textContent='Outline at least three points around the part first.';return;}
      pick.value=String(draft.start.page);paint();msg.textContent='Click where the center of the moving part should finish.';
    }else{if(draft?.kind!=='panels')draft={kind:'panels',before:'',after:''};msg.textContent='Drag a box around the '+(mode==='start'?'before':'after')+' drawing.';}
  }
  box.querySelectorAll('[data-act]').forEach(b=>b.onclick=()=>action(b.dataset.act));
  function point(e){const r=canvas.getBoundingClientRect(),clamp=x=>Math.max(0,Math.min(1,x));return [clamp((e.clientX-r.left)/r.width),clamp((e.clientY-r.top)/r.height)];}
  canvas.onpointerdown=e=>{
    const p=point(e);
    if(mode==='outline'){if(draft.outline.length<80)draft.outline.push(p);paint();}
    else if(mode==='target'){draft.to=p;mode='';paint();msg.textContent='Choose Apply illustration to save the motion.';}
    else if(mode==='start'||mode==='end'){anchor=p;canvas.setPointerCapture(e.pointerId);}
  };
  function rectangle(p){return {x:Math.min(anchor[0],p[0]),y:Math.min(anchor[1],p[1]),w:Math.abs(anchor[0]-p[0]),h:Math.abs(anchor[1]-p[1])};}
  canvas.onpointermove=e=>{if(anchor){drag=rectangle(point(e));paint();}};
  canvas.onpointerup=e=>{if(!anchor)return;draft[mode]={page:page(),box:rectangle(point(e))};anchor=null;drag=null;mode='';paint();msg.textContent='Panel marked. Mark its partner or apply the illustration.';};
  canvas.onpointercancel=()=>{anchor=null;drag=null;paint();};describe();
}
