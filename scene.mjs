// Coordinates are fractions of the full, upright source page.
const unit = x => Number.isFinite(x) && x >= 0 && x <= 1;
export function validBox(b) {
  return b && [b.x,b.y,b.w,b.h].every(unit) && b.w > .002 && b.h > .002 &&
    b.x + b.w <= 1.00001 && b.y + b.h <= 1.00001;
}
export function readScene(scene, pages) {
  if (!scene) return null;
  const panel = p => p && pages.includes(p.page) && validBox(p.box);
  const point = p => Array.isArray(p) && p.length === 2 && p.every(unit);
  const cleanPanel = p => ({page:p.page,box:{x:p.box.x,y:p.box.y,w:p.box.w,h:p.box.h}});
  if (!panel(scene.start)) throw new Error('The illustration needs a valid source panel.');
  const base = {kind:scene.kind,start:cleanPanel(scene.start),
    before:String(scene.before || '').slice(0,400),after:String(scene.after || '').slice(0,400)};
  if (scene.kind === 'panels' && panel(scene.end)) return {...base,end:cleanPanel(scene.end)};
  if (scene.kind === 'move' && Array.isArray(scene.outline) && scene.outline.length >= 3 &&
      scene.outline.length <= 80 && scene.outline.every(point) && point(scene.to) &&
      Number.isFinite(scene.turn) && Math.abs(scene.turn) <= 720) {
    const b = scene.start.box, inside=([x,y]) => x>=b.x && y>=b.y && x<=b.x+b.w && y<=b.y+b.h;
    if (!scene.outline.every(inside) || !inside(scene.to)) throw new Error('Moving part must fit within the source panel.');
    const area=Math.abs(scene.outline.reduce((sum,[x,y],i,a)=>{const [u,v]=a[(i+1)%a.length];return sum+x*v-u*y;},0))/2;
    if (area<.00001) throw new Error('Outline a visible area of the moving part.');
    return {...base,outline:scene.outline.map(p=>[...p]),to:[...scene.to],turn:scene.turn};
  }
  throw new Error('The step has an unsupported illustration plan.');
}
function panelCanvas(panel, pages) {
  const im=pages(panel.page), b=panel.box;
  const canvas=document.createElement('canvas');
  const width=b.w*im.naturalWidth,height=b.h*im.naturalHeight;
  const scale=Math.min(2,1152/Math.max(width,height));
  canvas.width=Math.max(1,Math.round(width*scale));canvas.height=Math.max(1,Math.round(height*scale));
  canvas.getContext('2d').drawImage(im,b.x*im.naturalWidth,b.y*im.naturalHeight,width,height,0,0,canvas.width,canvas.height);
  return canvas;
}
export function contain(g,img,box) {
  const w=img.videoWidth||img.width,h=img.videoHeight||img.height;
  if (!w || !h) return;
  const k=Math.min(box.w/w,box.h/h);
  g.drawImage(img,box.x+(box.w-w*k)/2,box.y+(box.h-h*k)/2,w*k,h*k);
}
export function compileScene(scene, pages) {
  const first=panelCanvas(scene.start,pages);
  if(scene.kind==='panels'){
    const last=panelCanvas(scene.end,pages);
    return (g,box,t)=>contain(g,t<.5?first:last,box);
  }
  const b=scene.start.box;
  const local=([x,y])=>[(x-b.x)*first.width/b.w,(y-b.y)*first.height/b.h];
  const poly=scene.outline.map(local),target=local(scene.to);
  const center=poly.reduce((c,p)=>[c[0]+p[0]/poly.length,c[1]+p[1]/poly.length],[0,0]);
  const path=new Path2D();poly.forEach(([x,y],i)=>i?path.lineTo(x,y):path.moveTo(x,y));path.closePath();
  const layer=document.createElement('canvas');layer.width=first.width;layer.height=first.height;
  const lg=layer.getContext('2d');lg.clip(path);lg.drawImage(first,0,0);
  const bg=first.getContext('2d');bg.fillStyle='white';bg.fill(path);
  return (g,box,t)=>{
    const k=Math.min(box.w/first.width,box.h/first.height);
    const u=Math.max(0,Math.min(1,(t-.12)/.76)),ease=u*u*(3-2*u);
    g.save();g.translate(box.x+(box.w-first.width*k)/2,box.y+(box.h-first.height*k)/2);
    g.scale(k,k);g.beginPath();g.rect(0,0,first.width,first.height);g.clip();g.drawImage(first,0,0);
    g.translate(center[0]+(target[0]-center[0])*ease,center[1]+(target[1]-center[1])*ease);
    g.rotate(scene.turn*Math.PI/180*ease);g.drawImage(layer,-center[0],-center[1]);g.restore();
  };
}
export function frameImage(draw,t) {
  const c=document.createElement('canvas');c.width=960;c.height=540;const g=c.getContext('2d');
  g.fillStyle='white';g.fillRect(0,0,c.width,c.height);draw(g,{x:0,y:0,w:c.width,h:c.height},t);
  return c.toDataURL('image/jpeg',.9);
}
