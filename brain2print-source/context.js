// MRI context for the saved Brain2Print result. NiiVue handles the NIfTI affine
// and the matching RAS mesh coordinates; no extra alignment is applied here.
import { Niivue } from '@niivue/niivue';

const $ = id => document.getElementById(id);
const root = $('context-lab');
const canvas = $('brain2print-context-canvas');
const dataBase = new URL('../../public/data/', location.href);
const viewButtons = [...document.querySelectorAll('[data-context-view]')];
const cameraButtons = [...document.querySelectorAll('[data-context-camera]')];
const defaults = { cut:55, azimuth:160, elevation:12, zoom:1.5 };
let nv, ready=false, active=true, disposed=false, mode='cutaway', resizeFrame=0, lastHeight=0;
const abortController = new AbortController();

function notifyHeight() {
  if (disposed) return;
  const height = Math.ceil(root.getBoundingClientRect().height);
  if (height === lastHeight) return;
  lastHeight = height;
  parent.postMessage({type:'brain2print-context:height',height},location.origin);
}
function queueResize() {
  if (disposed || resizeFrame) return;
  resizeFrame=requestAnimationFrame(()=>{
    resizeFrame=0;
    notifyHeight();
    if (ready && active && !document.hidden && canvas.clientWidth && canvas.clientHeight) nv.resizeListener();
  });
}
const resizeObserver = new ResizeObserver(queueResize);
resizeObserver.observe(root);
resizeObserver.observe(canvas.parentElement);

function updateControls() {
  const available=ready && active;
  viewButtons.forEach(button=>{button.disabled=!available;button.setAttribute('aria-pressed',String(button.dataset.contextView===mode));});
  cameraButtons.forEach(button=>{button.disabled=!available || mode==='planes';});
  $('context-reset').disabled=!available;
  $('context-cut').disabled=!available || mode!=='cutaway';
  $('context-brain-visible').disabled=!available;
  $('context-brain-opacity').disabled=!available || !$('context-brain-visible').checked;
  $('context-through').disabled=!available || mode==='planes' || !$('context-brain-visible').checked;
  canvas.inert=!active;
}
function updateBrain() {
  if (!ready) return;
  const shown=$('context-brain-visible').checked;
  const opacity=Number($('context-brain-opacity').value)/100;
  nv.setMeshProperty(nv.meshes[0].id,'visible',shown);
  nv.setMeshProperty(nv.meshes[0].id,'opacity',opacity);
  // meshXRay is explicitly an illustrative, depth-independent overlay.
  nv.opts.meshXRay=mode!=='planes' && shown && $('context-through').checked ? .45*opacity : 0;
  $('context-brain-opacity-value').textContent=`${Math.round(opacity*100)}%`;
  nv.drawScene();
  updateControls();
}
function updateCut() {
  const value=Number($('context-cut').value);
  $('context-cut-value').textContent=`${value}%`;
  if (!ready) return;
  // The plane travels anterior to posterior. It clips only the MRI volume;
  // NiiVue's 3D mesh pass retains the intact predicted brain surface.
  nv.setClipPlane(mode==='cutaway' && value>0 ? [.5-value/100,180,0] : [2,180,0]);
}
function setMode(next) {
  if (!ready || !['cutaway','whole','planes'].includes(next)) return;
  mode=next;
  nv.opts.multiplanarForceRender=false;
  nv.opts.multiplanarShowRender=0;
  nv.setSliceType(mode==='planes' ? nv.sliceTypeMultiplanar : nv.sliceTypeRender);
  nv.setOpacity(0,1);
  // In slice mode show a narrow portion of the surface at each MRI plane.
  nv.setMeshThicknessOn2D(1.5);
  $('context-gestures').textContent=mode==='planes' ? 'Click to position · Scroll to browse' : 'Drag to rotate · Scroll to zoom';
  $('context-status').textContent=mode==='planes'
    ? 'Linked slices of the same MRI. Pink marks the model near each slice.'
    : mode==='whole'
      ? 'Full captured MRI. Use Cutaway to reveal the brain inside.'
      : 'The cut removes MRI from view; the brain model stays intact.';
  updateCut();updateBrain();queueResize();
}
function setCamera(name) {
  if (!ready || mode==='planes') return;
  const angles={front:[180,0],side:[90,0],angle:[defaults.azimuth,defaults.elevation]};
  if (angles[name]) nv.setRenderAzimuthElevation(...angles[name]);
}
function reset() {
  if (!ready) return;
  $('context-cut').value=defaults.cut;
  $('context-brain-visible').checked=true;
  $('context-brain-opacity').value=100;
  $('context-through').checked=false;
  nv.scene.crosshairPos=[.5,.5,.5];
  nv.setScale(defaults.zoom);
  nv.setRenderAzimuthElevation(defaults.azimuth,defaults.elevation);
  setMode('cutaway');
}

viewButtons.forEach(button=>button.addEventListener('click',()=>setMode(button.dataset.contextView)));
cameraButtons.forEach(button=>button.addEventListener('click',()=>setCamera(button.dataset.contextCamera)));
$('context-cut').addEventListener('input',updateCut);
$('context-brain-visible').addEventListener('change',updateBrain);
$('context-brain-opacity').addEventListener('input',updateBrain);
$('context-through').addEventListener('change',updateBrain);
$('context-reset').addEventListener('click',reset);
$('context-retry').addEventListener('click',()=>location.reload());

function parentMessage(event) {
  if(event.origin!==location.origin || event.source!==parent || !event.data || typeof event.data!=='object') return;
  if(event.data.type==='brain2print-context:resize') {lastHeight=0;queueResize();}
  if(event.data.type==='brain2print-context:active' && typeof event.data.active==='boolean') {
    active=event.data.active;updateControls();
    if(active) queueResize();
  }
}
window.addEventListener('message',parentMessage);
document.addEventListener('visibilitychange',queueResize);
window.addEventListener('pagehide',event=>{
  if(event.persisted) return;
  disposed=true;abortController.abort();resizeObserver.disconnect();
  if(resizeFrame) cancelAnimationFrame(resizeFrame);
  window.removeEventListener('message',parentMessage);
  document.removeEventListener('visibilitychange',queueResize);
  nv?.cleanup();
});

async function load() {
  root.setAttribute('aria-busy','true');
  try {
    const response=await fetch(new URL('b2p-result.json?v=protected-nifti-1',dataBase),{signal:abortController.signal});
    if(!response.ok) throw new Error('Saved result descriptor could not load.');
    const result=await response.json();
    const saved=result.result;
    if(saved?.conformedFile!=='display-b2p-conformed.nii.gz' || saved?.meshFile!=='b2p-brain.mz3') throw new Error('Unexpected saved result paths.');
    if(disposed) return;
    nv=new Niivue({backColor:[.051,.094,.153,1],show3Dcrosshair:false,isOrientCube:true,isRadiologicalConvention:true,sagittalNoseLeft:true,isSliceMM:true,meshThicknessOn2D:1.5,multiplanarLayout:2,crosshairColor:[.65,.86,.78,.8],dragAndDropEnabled:false,isColorbar:false,clipPlaneColor:[.8,.85,.88,0]});
    await nv.attachToCanvas(canvas);
    if(disposed) {nv.cleanup();return;}
    nv.opts.dragMode=nv.dragModes.pan;
    nv.opts.yoke3Dto2DZoom=false;
    nv.opts.crosshairGap=8;
    await nv.loadVolumes([{url:new URL(saved.conformedFile,dataBase).href,colormap:'gray'}]);
    if(disposed) return;
    await nv.loadMeshes([{url:new URL(saved.meshFile,dataBase).href}]);
    if(disposed) return;
    if(nv.volumes.length!==1 || nv.meshes.length!==1) throw new Error('The MRI and model did not finish loading.');
    nv.setMeshProperty(nv.meshes[0].id,'rgba255',[207,150,147,255]);
    nv.setMeshShader(nv.meshes[0].id,'Phong');
    ready=true;reset();
    $('context-loading').hidden=true;
    root.setAttribute('aria-busy','false');
    queueResize();
    parent.postMessage({type:'brain2print-context:ready'},location.origin);
  } catch(error) {
    if(disposed || error.name==='AbortError') return;
    console.error('MRI context:',error);
    ready=false;updateControls();
    $('context-loading').classList.add('error');
    $('context-loading-text').textContent='The MRI context could not load. Try again, or use a browser with WebGL 2 enabled.';
    $('context-retry').hidden=false;
    $('context-status').textContent='The saved MRI and brain model are required for this view.';
    root.setAttribute('aria-busy','false');
    queueResize();
    parent.postMessage({type:'brain2print-context:error'},location.origin);
  }
}
load();
