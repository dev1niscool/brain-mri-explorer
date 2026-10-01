// Adapted from niivue/brain2print, MIT. Inference worker and tensor operations
// remain upstream. This interface fixes the input to the owner's public scan.
import { NVMeshUtilities } from '@niivue/niivue';
import { BrainSurfaceNiivue } from './surface-niivue.js';
import { inferenceModelsList, brainChopOpts } from './brainchop-parameters.js';
import BrainchopWorker from './brainchop-webworker.js?worker';
import { antiAliasCuberille, setPipelinesBaseUrl as setCuberilleUrl } from '@itk-wasm/cuberille';
import { repair, smoothRemesh, keepLargestComponent, setPipelinesBaseUrl as setMeshUrl } from '@itk-wasm/mesh-filters';
import { nii2iwi, iwm2meshCore } from '@niivue/cbor-loader';

const $ = id => document.getElementById(id);
const dataBase = new URL('../../public/data/', location.href);
const pipelines = new URL('./pipelines/', location.href).href;
setCuberilleUrl(pipelines); setMeshUrl(pipelines);
const model = { ...inferenceModelsList[5], isScalar: false };
let tissueColors = { R:[0,145,214], G:[0,203,152], B:[0,185,158], labels:['Background','White matter','Gray matter'] };
const sourceFile = 'display-t1-axial.nii.gz';
const sourceUrl = new URL(sourceFile, dataBase).href;
let nv, worker, busy = false, hasLabels = false, startTime = 0, timer, runToken = 0, sliceView = 'surface', resultInfo;
let activeMeshSettings = { smoothing: 3, detail: 25 };
let segmentationEntry=model, segmentationSeconds=0, freshSegmentation=false;

function status(message, error = false) { $('status').textContent = message; $('status').classList.toggle('error', error); }
async function colorsFor(entry) {
  const response=await fetch(new URL(entry.colormapPath,location.href));
  if(!response.ok)throw new Error('Tissue color key could not load');
  const colors=await response.json();
  colors.R[1]=145;colors.G[1]=203;colors.B[1]=185;colors.R[2]=214;colors.G[2]=152;colors.B[2]=158;
  return colors;
}
function updateLegend() {
  $('label-key').replaceChildren(...tissueColors.labels.slice(1).map((label,index)=>{
    const item=document.createElement('div'),dot=document.createElement('i');dot.style.background=`rgb(${tissueColors.R[index+1]},${tissueColors.G[index+1]},${tissueColors.B[index+1]})`;
    item.append(dot,document.createTextNode(label.replaceAll('-',' ')));return item;
  }));
  $('structure-note').hidden=tissueColors.labels.length<4;
}
function reportHeight() { parent.postMessage({ type:'brain2print:height', height:Math.ceil(document.querySelector('.lab').getBoundingClientRect().height) }, location.origin); }
new ResizeObserver(reportHeight).observe(document.body);
function updateControls() {
  $('run').disabled = busy || !nv?.volumes.length;
  $('mesh').disabled = busy || !hasLabels;
  $('download').disabled = busy || !nv?.meshes.length;
  $('smooth').disabled = busy; $('detail').disabled = busy;
  $('cancel').hidden = !busy;
  $('progress').hidden = !busy;
}
function begin(message) {
  busy = true; startTime = performance.now(); $('progress').value = 0;
  $('elapsed').hidden = false; $('elapsed').textContent = '0 seconds elapsed';
  clearInterval(timer); timer = setInterval(() => { $('elapsed').textContent = `${Math.round((performance.now()-startTime)/1000)} seconds elapsed`; }, 1000);
  status(message); updateControls();
}
function finish(message, error = false) {
  worker?.terminate(); worker = null; busy = false; clearInterval(timer); $('elapsed').hidden=true; status(message,error); updateControls();
}
function fail(error) { console.error(error); finish('Processing could not finish on this device. The saved Brain2Print result remains available after reloading. Try again on a desktop browser with hardware acceleration.', true); }
function setView(view) {
  sliceView = view;
  nv.surfaceOnly = view === 'surface';
  nv.setSliceType(view === 'surface' ? nv.sliceTypeRender : nv.sliceTypeMultiplanar);
  nv.opts.multiplanarForceRender = view === 'both';
  nv.opts.multiplanarShowRender = view === 'both' ? 1 : 0;
  $('clip-depth').disabled = view === 'surface';
  $('overlay-opacity').disabled = view === 'surface';
  $('gestures').textContent = view === 'surface' ? 'Drag to rotate · Scroll to zoom' : 'Click to position · Scroll MRI to browse';
  nv.setClipPlane([2,0,90]); $('clip-depth').value=0; $('cut-value').textContent='Off';
  if (nv.volumes[0]) nv.setOpacity(0, view === 'surface' && nv.meshes.length ? 0 : 1);
  if (nv.volumes[1]) nv.setOpacity(1, view === 'surface' && nv.meshes.length ? 0 : Number($('overlay-opacity').value)/100);
  document.querySelectorAll('[data-view]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.view===view)));
  nv.resizeListener(); nv.drawScene();
}
function styleMesh() {
  if (!nv.meshes.length) return;
  nv.setMeshProperty(nv.meshes[0].id, 'rgba255', [207,150,147,255]);
  const faces = nv.meshes[0].tris.length / 3;
  $('mesh-stats').textContent = `${Math.round(faces).toLocaleString()} triangles · millimeter coordinates`;
  setView(sliceView);
}
async function clearOverlays() { while(nv.volumes.length>1) await nv.removeVolume(nv.volumes[1]); hasLabels=false; }
async function ensureConformed() {
  const image = nv.volumes[0];
  const conformed = image.dims[1]===256 && image.dims[2]===256 && image.dims[3]===256 && image.img instanceof Uint8Array && image.permRAS[0]===-1 && image.permRAS[1]===3 && image.permRAS[2]===-2;
  if(conformed) return;
  const next = await nv.conform(image, false, true, false, true);
  await nv.removeVolume(image); await nv.addVolume(next);
}
async function applyLabels(img) {
  await clearOverlays();
  while(nv.meshes.length)nv.removeMesh(nv.meshes[0]);
  $('mesh-stats').textContent='Tissue labels ready · surface pending';
  tissueColors=await colorsFor(model);updateLegend();
  segmentationEntry=model;
  freshSegmentation=true;
  const overlay = await nv.volumes[0].clone(); overlay.zeroImage();
  overlay.hdr.scl_inter=0; overlay.hdr.scl_slope=1; overlay.hdr.intent_code=1002;
  overlay.img = new Uint8Array(img); overlay.setColormapLabel(tissueColors); overlay.opacity=Number($('overlay-opacity').value)/100;
  await nv.addVolume(overlay); hasLabels=true;
}
async function run() {
  if(busy) return;
  const token=++runToken; begin('Preparing the public display MRI for Brain2Print…');
  try {
    if (typeof OffscreenCanvas === 'undefined' || typeof Worker === 'undefined') throw new Error('This browser cannot run the GPU worker.');
    // A rerun starts from the quantized native-grid scan, not the cached
    // conformed display proxy or resampled label overlay.
    await clearOverlays(); await nv.loadVolumes([{url:sourceUrl}]);
    if(token!==runToken)return;
    await ensureConformed();
    if(token!==runToken)return;
    const rendererInfo=nv.gl.getExtension('WEBGL_debug_renderer_info');
    model.isNvidia=!!rendererInfo && String(nv.gl.getParameter(rendererInfo.UNMASKED_RENDERER_WEBGL)).includes('NVIDIA');
    const opts={...brainChopOpts,telemetryFlag:false,rootURL:new URL('./',location.href).href.replace(/\/$/,'')};
    worker = new BrainchopWorker();
    worker.onerror = event => { if(token===runToken) fail(new Error(event.message || 'GPU inference failed')); };
    worker.onmessage = async ({data}) => {
      if(token!==runToken)return;
      if(data.cmd==='ui') {
        if(data.modalMessage) { fail(new Error(data.modalMessage)); return; }
        if(Number.isFinite(data.progressFrac) && data.progressFrac>=0) $('progress').value=Math.min(1,data.progressFrac);
        if(data.message) status(String(data.message).replace(/<[^>]*>/g,''));
      }
      if(data.cmd==='img') {
        worker?.terminate(); worker=null;
        try {
          await applyLabels(data.img);
          if(token!==runToken)return;
          const seconds=(performance.now()-startTime)/1000;
          segmentationSeconds=seconds;
          $('result-label').textContent='COMPUTED IN THIS BROWSER';
          $('result-description').textContent='Brain2Print has predicted labels from the public 8-bit display MRI. This can differ from the saved original-source result. Build a surface from their combined foreground.';
          $('run').textContent='Run segmentation again';
          setView('both'); finish(`Tissue segmentation complete in ${Math.round(seconds)} seconds. Creating the surface next…`);
          await makeMesh();
        } catch(error) { if(token===runToken)fail(error); }
      }
    };
    worker.postMessage({opts,modelEntry:{...model},niftiHeader:{datatypeCode:nv.volumes[0].hdr.datatypeCode,dims:nv.volumes[0].hdr.dims},niftiImage:nv.volumes[0].img});
  } catch(error) { if(token===runToken)fail(error); }
}

// The upstream Brain2Print "better" mesh sequence: anti-aliased cuberille,
// repair, largest component, smoothing/remeshing, and final repair.
async function makeMesh() {
  if(busy || !hasLabels)return;
  const token=++runToken; begin('Creating a surface from the tissue labels…');
  // ITK tasks run in workers; cancel unloads this sandbox to free those workers.
  $('cancel').textContent='Stop processing';
  try {
    const overlay=nv.volumes[1];
    // Mesh the union of every predicted foreground label. Passing class IDs as
    // scalar intensities would threshold away low-numbered anatomical classes.
    const foreground=Uint8Array.from(overlay.img,value=>value>0?1:0);
    const image=nii2iwi(overlay.hdr,foreground,false); image.size=image.size.map(Number);
    const {mesh}=await antiAliasCuberille(image,{noClosing:true});
    if(token!==runToken)return;
    $('progress').value=.25; status('Repairing the surface…');
    const {outputMesh:repaired}=await repair(mesh,{maximumHoleArea:50});
    if(token!==runToken)return;
    const {outputMesh:largest}=await keepLargestComponent(repaired);
    if(token!==runToken)return;
    $('progress').value=.55; status('Smoothing and simplifying the mesh…');
    activeMeshSettings={smoothing:Number($('smooth').value),detail:Number($('detail').value)};
    const {outputMesh:smoothed}=await smoothRemesh(largest,{newtonIterations:activeMeshSettings.smoothing,numberPoints:activeMeshSettings.detail});
    if(token!==runToken)return;
    $('progress').value=.85;
    const {outputMesh:final}=await repair(smoothed,{maximumHoleArea:50});
    if(token!==runToken)return;
    const converted=iwm2meshCore(final);
    const buffer=NVMeshUtilities.createMZ3(converted.positions,converted.indices,false);
    while(nv.meshes.length)nv.removeMesh(nv.meshes[0]);
    await nv.loadFromArrayBuffer(buffer,'brain2print-brain.mz3');
    styleMesh(); setView('surface');
    const seconds=Math.round((performance.now()-startTime)/1000);
    finish(`Brain2Print surface ready. Mesh creation took ${seconds} seconds.`);
    $('result-label').textContent=freshSegmentation?'COMPUTED IN THIS BROWSER':'MESH REBUILT IN THIS BROWSER';
    $('result-description').textContent=freshSegmentation?'This surface was computed from the public 8-bit MRI copy. It can differ from the saved original-source result.':'This surface was rebuilt from the 1.25 mm public label display. Its boundaries can differ from the saved original-label result.';
  }catch(error){if(token===runToken)fail(error);}
}

async function main() {
  nv=new BrainSurfaceNiivue({backColor:[.045,.08,.13,1],show3Dcrosshair:false,isOrientCube:true,isRadiologicalConvention:true,sagittalNoseLeft:true,isSliceMM:true,meshThicknessOn2D:0,multiplanarLayout:2,crosshairColor:[.6,.8,.75,.8],dragAndDropEnabled:false,onLocationChange:data=>{const value=data?.values?.[1]?.value;const label=tissueColors.labels[Math.round(value)];if(label)$('picked-label').textContent='Predicted label: '+label.replaceAll('-',' ');}});
  await nv.attachToCanvas($('brain2print-canvas'));
  nv.opts.dragMode=nv.dragModes.pan; nv.opts.multiplanarForceRender=true; nv.opts.yoke3Dto2DZoom=false; nv.opts.crosshairGap=9; nv.volScaleMultiplier=1.65;
  $('run').onclick=run; $('mesh').onclick=makeMesh;
  $('cancel').onclick=()=>{ ++runToken; worker?.terminate(); worker=null; location.reload(); };
  $('download').onclick=()=>{if(!busy && nv.meshes.length)NVMeshUtilities.saveMesh(nv.meshes[0].pts,nv.meshes[0].tris,'devin-brain2print-brain.stl',true);};
  $('smooth').oninput=()=>{$('smooth-value').textContent=$('smooth').value+' passes';};
  $('overlay-opacity').oninput=()=>{$('opacity-value').textContent=$('overlay-opacity').value+'%';if(nv.volumes[1])nv.setOpacity(1,Number($('overlay-opacity').value)/100);};
  $('clip-depth').oninput=()=>{const value=Number($('clip-depth').value);$('cut-value').textContent=value?value+'%':'Off';nv.setClipPlane(value?[(value-50)/50,0,90]:[2,0,90]);};
  $('reset-view').onclick=()=>{nv.volScaleMultiplier=1.65;nv.setRenderAzimuthElevation(110,15);nv.scene.crosshairPos=[.5,.5,.5];$('clip-depth').value=0;$('clip-depth').oninput();nv.drawScene();};
  document.querySelectorAll('[data-view]').forEach(b=>b.onclick=()=>setView(b.dataset.view));
  try {
    const response=await fetch(new URL('b2p-result.json?v=protected-nifti-1',dataBase));
    if(!response.ok)throw new Error('Saved result not available');
    resultInfo=await response.json();
    const saved=resultInfo.result;
    for(const key of ['conformedFile','segmentationFile','meshFile'])if(typeof saved?.[key]!=='string'||!['display-b2p-conformed.nii.gz','display-b2p-segmentation.nii.gz','b2p-brain.mz3'].includes(saved[key])||saved[key].includes('..'))throw new Error('Invalid saved result path');
    await nv.loadVolumes([{url:new URL(saved.conformedFile,dataBase).href}]);
    const {NVImage}=await import('@niivue/niivue');
    segmentationEntry=inferenceModelsList[resultInfo.selectedModel.upstreamIndex];
    segmentationSeconds=resultInfo.browserRun?.segmentationSeconds || 0;
    tissueColors=await colorsFor(segmentationEntry);updateLegend();
    const overlay=await NVImage.loadFromUrl({url:new URL(saved.segmentationFile,dataBase).href});
    overlay.setColormapLabel(tissueColors);overlay.opacity=.45;await nv.addVolume(overlay);hasLabels=true;
    await nv.loadMeshes([{url:new URL(saved.meshFile,dataBase).href}]);
    styleMesh();
    $('result-label').textContent='SAVED BRAIN2PRINT RESULT';
    $('result-description').textContent='The saved surface is Brain2Print’s actual original-source result. MRI intensities are reduced for public display, and the label overlay uses a 1.25 mm grid. Reruns use a public 8-bit MRI copy and can differ.';
    $('run').textContent='Rerun on display MRI';
    status('Saved result loaded. No new processing has run on this device.');
  }catch(error){
    while(nv.meshes.length)nv.removeMesh(nv.meshes[0]);
    await nv.loadVolumes([{url:sourceUrl}]);hasLabels=false;
    status('The public T1 display copy is ready. Run Brain2Print to generate tissue labels and a mesh.');
  }
  $('loading').hidden=true;nv.setRenderAzimuthElevation(110,15);setView(hasLabels?'surface':'both');updateControls();
  window.addEventListener('message',event=>{if(event.origin===location.origin && event.data?.type==='brain2print:resize'){nv.resizeListener();reportHeight();}});
}
main().catch(error=>{console.error(error);$('loading').textContent='The viewer could not start. Reload or try a desktop browser with WebGL enabled.';status('3D browser support is required for this viewer.',true);});
