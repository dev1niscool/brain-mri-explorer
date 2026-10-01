import * as THREE from 'three';
import {OrbitControls} from './vendor/OrbitControls.js';
import {STLLoader} from './vendor/STLLoader.js';
import {mergeVertices} from './vendor/BufferGeometryUtils.js';

const MODELS = {
  b2p: {file:'b2p-print-full.stl',stats:'b2p-brain-mesh-stats',color:0xcf9693},
  b2pStand: {file:'b2p-display-stand.stl',stats:'b2p-stand-mesh-stats',color:0x29475b,stand:true},
  head: {file:'head.stl',stats:'head-mesh-stats',color:0xc4af9f},
  brain: {file:'brain.stl',stats:'brain-mesh-stats',color:0xcf9693},
  stand: {file:'brain-display-stand.stl',stats:'stand-mesh-stats',color:0x29475b,stand:true},
};
const MODES = {
  b2p: {meshes:['b2p'],name:'Brain2Print · full detail',note:'The full saved Brain2Print surface. Its automated reconstruction omits some tissue near the top; fine anatomy is limited by the 5 mm source slices.'},
  'b2p-display': {meshes:['b2p','b2pStand'],name:'Brain2Print + fitted stand',note:'A removable cradle fitted to the full Brain2Print STL. Print both at the same scale. Fit is checked digitally; no physical test print has been made.'},
  head: {meshes:['head'],name:'Captured head',note:'The outer head and face captured by the MRI. The lower boundary is cropped and closed; this is a scalp surface, not skull bone.'},
  brain: {meshes:['brain'],name:'HD-BET brain',note:'The earlier HD-BET surface with local processing. It is a different reconstruction from Brain2Print, with approximate fine boundaries.'},
  display: {meshes:['brain','stand'],name:'HD-BET brain + stand',note:'The HD-BET surface with its own fitted cradle. Print this pair at the same scale; its stand is not fitted to the Brain2Print model.'},
};

/** Display source STL coordinates unchanged; only the shared display group rotates. */
export class PrintStudio {
  constructor(root, version) {
    this.root=root; this.version=version; this.mode='b2p'; this.active=false;
    this.meshes={}; this.meshPromises={}; this.modelInformation={}; this.selection=0;
    this.events=new AbortController(); this.disposed=false; this.contextLost=false;
    this.q=selector=>root.querySelector(selector);
    this.status=this.q('[data-print-status]');
    const on=(target,type,handler)=>target.addEventListener(type,handler,{signal:this.events.signal});
    root.querySelectorAll('[data-print-object]').forEach(button=>on(button,'click',()=>this.select(button.dataset.printObject)));
    root.querySelectorAll('[data-print-camera]').forEach(button=>on(button,'click',()=>this.frame(button.dataset.printCamera)));
    this.setDownloadLinks();
    this.informationReady=this.loadInformation();
    this.ready=this.init().catch(error=>{
      if(this.disposed)return false;
      console.error('Print preview:',error);
      this.showStatus('The 3D preview could not open. Reload to try again; the STL downloads below remain available.');
      this.setCameraEnabled(false);
      return false;
    });
  }

  assetUrl(file) {
    if(!/^[\w.-]+\.(?:stl|json|zip)$/.test(file))throw new Error('Invalid print asset path');
    return `./public/data/${file}?v=${encodeURIComponent(this.version)}`;
  }
  setDownloadLinks() {
    const files={
      'download-b2p-brain':'b2p-print-full.stl','download-b2p-compact':'b2p-print-compact.stl',
      'download-b2p-stand':'b2p-display-stand.stl','download-b2p-kit':'b2p-display-kit.zip',
      'download-brain':'brain.stl','download-head':'head.stl',
      'download-stand':'brain-display-stand.stl','download-display-kit':'brain-display-kit.zip',
    };
    for(const [id,file] of Object.entries(files)){const link=document.getElementById(id);if(link)link.href=this.assetUrl(file);}
  }
  async readInformation(file) {
    const response=await fetch(this.assetUrl(file),{signal:this.events.signal});
    if(!response.ok)throw new Error('Print model information could not load');
    return response.json();
  }
  async loadInformation() {
    const jobs=[
      {keys:['b2p'],file:'b2p-print-editions.json',read:meta=>{
        const full=meta.editions?.find(edition=>edition.id==='full');
        if(meta.version!==1||full?.file!==MODELS.b2p.file)throw new Error('Unexpected Brain2Print edition');
        return {b2p:full};
      }},
      {keys:['b2pStand'],file:'b2p-display-stand.json',read:meta=>{
        if(meta.version!==1||meta.brainFile!==MODELS.b2p.file||meta.standFile!==MODELS.b2pStand.file||meta.kitFile!=='b2p-display-kit.zip')throw new Error('Unexpected Brain2Print stand');
        return {b2pStand:meta};
      }},
      {keys:['brain','head','stand'],file:'print-edition.json',read:meta=>{
        if(meta.version!==1||meta.brainFile!==MODELS.brain.file||meta.headFile!==MODELS.head.file||meta.standFile!==MODELS.stand.file)throw new Error('Unexpected HD-BET print edition');
        return {brain:meta.brain,head:meta.head,stand:meta.stand};
      }},
    ];
    return Promise.all(jobs.map(async job=>{
      try {
        const information=job.read(await this.readInformation(job.file));
        if(this.disposed)return;
        Object.assign(this.modelInformation,information);
      } catch(error) {
        if(this.disposed||error.name==='AbortError')return;
        console.warn(`Print details unavailable: ${job.file}`);
      }
      job.keys.forEach(key=>this.updateStats(key));
    }));
  }
  updateStats(key) {
    const target=document.getElementById(MODELS[key].stats);if(!target)return;
    const mesh=this.meshes[key],meta=this.modelInformation[key];
    const dimensions=mesh?mesh.geometry.boundingBox.getSize(new THREE.Vector3()).toArray():meta?.dimensionsMm;
    const triangles=mesh?(mesh.geometry.index?.count||mesh.geometry.getAttribute('position').count)/3:meta?.triangles??meta?.faces??meta?.topology?.faces;
    const words=[];
    if(Array.isArray(dimensions)&&dimensions.length===3&&dimensions.every(Number.isFinite))words.push(`${dimensions.map(Math.round).join(' × ')} mm`);
    if(Number.isFinite(triangles))words.push(`${Math.round(triangles).toLocaleString('en-US')} triangles`);
    if((meta?.watertight??meta?.topology?.watertight)===true)words.push('Closed surface');
    target.textContent=words.join(' · ')||'Dimensions are in the STL; detailed checks could not load.';
  }

  async init() {
    const holder=this.q('[data-print-canvas]');
    this.renderer=new THREE.WebGLRenderer({antialias:true,alpha:true,powerPreference:'low-power'});
    this.renderer.setPixelRatio(Math.min(devicePixelRatio,2));
    this.renderer.outputColorSpace=THREE.SRGBColorSpace;
    this.renderer.toneMapping=THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure=1;this.renderer.setClearColor(0x000000,0);
    holder.append(this.renderer.domElement);
    this.scene=new THREE.Scene();this.camera=new THREE.PerspectiveCamera(32,1,.1,4000);
    this.controls=new OrbitControls(this.camera,this.renderer.domElement);
    this.controls.enableDamping=false;this.controls.minDistance=90;this.controls.maxDistance=1300;
    this.controls.addEventListener('change',()=>this.draw());
    this.scene.add(new THREE.HemisphereLight(0xfff4ed,0x314a60,2));
    for(const [color,power,position] of [[0xfff0e8,2.3,[-220,320,-270]],[0xd9f3f0,.8,[250,50,-60]],[0xe0edff,1.2,[20,120,250]]]){
      const light=new THREE.DirectionalLight(color,power);light.position.set(...position);this.scene.add(light);
    }
    this.group=new THREE.Group();this.group.rotation.x=-Math.PI/2;this.scene.add(this.group);
    this.loader=new STLLoader();
    this.observer=new ResizeObserver(()=>this.resize());this.observer.observe(holder);
    holder.addEventListener('keydown',event=>this.keyboard(event),{signal:this.events.signal});
    this.renderer.domElement.addEventListener('webglcontextlost',event=>{
      event.preventDefault();this.contextLost=true;this.selection++;
      this.showStatus('The 3D preview was interrupted. Reload to restore it; the STL downloads remain available.');
      this.setCameraEnabled(false);
    },{signal:this.events.signal});
    this.root.querySelectorAll('[data-print-object]').forEach(button=>button.disabled=false);
    this.resize();return this.select(this.mode);
  }
  async loadMesh(key) {
    if(this.meshes[key])return this.meshes[key];
    if(this.meshPromises[key])return this.meshPromises[key];
    const promise=(async()=>{
      const spec=MODELS[key],raw=await this.loader.loadAsync(this.assetUrl(spec.file));
      if(this.disposed){raw.dispose();return null;}
      let geometry=raw;
      try {
        if(!spec.stand){raw.deleteAttribute('normal');geometry=mergeVertices(raw,.001);raw.dispose();geometry.computeVertexNormals();}
        geometry.computeBoundingBox();
        const bounds=geometry.boundingBox;
        if(bounds.isEmpty()||![...bounds.min.toArray(),...bounds.max.toArray()].every(Number.isFinite))throw new Error('Invalid print model bounds');
        const material=new THREE.MeshStandardMaterial({color:spec.color,roughness:spec.stand ? .78 : .7,metalness:.015});
        const mesh=new THREE.Mesh(geometry,material);mesh.visible=false;this.meshes[key]=mesh;this.group.add(mesh);this.updateStats(key);return mesh;
      } catch(error){geometry.dispose();throw error;}
    })();
    this.meshPromises[key]=promise;
    try{return await promise;}finally{if(this.meshPromises[key]===promise)delete this.meshPromises[key];}
  }
  setActive(active) {this.active=Boolean(active);if(this.controls)this.controls.enabled=this.active&&!this.contextLost;if(this.active)this.resize();}
  showStatus(text) {this.status.hidden=false;this.status.textContent=text;}
  setCameraEnabled(enabled) {this.root.querySelectorAll('[data-print-camera]').forEach(button=>button.disabled=!enabled);}
  async select(mode) {
    if(!Object.hasOwn(MODES,mode)||this.disposed||this.contextLost)return false;
    this.mode=mode;const info=MODES[mode],selection=++this.selection;
    this.root.querySelectorAll('[data-print-object]').forEach(button=>button.setAttribute('aria-pressed',String(button.dataset.printObject===mode)));
    this.q('[data-print-name]').textContent=info.name;
    this.q('[data-print-note]').textContent=info.note;
    if(!this.group)return false;
    this.box=null;this.setCameraEnabled(false);
    for(const mesh of Object.values(this.meshes))mesh.visible=false;
    this.q('[data-print-dimensions]').textContent='';
    this.showStatus(`Loading ${info.name.toLowerCase()}…`);this.draw();
    try {
      const meshes=await Promise.all(info.meshes.map(key=>this.loadMesh(key)));
      if(this.disposed||this.contextLost||selection!==this.selection)return false;
      this.box=new THREE.Box3();
      for(const mesh of meshes){mesh.visible=true;this.box.union(mesh.geometry.boundingBox);}
      const size=this.box.getSize(new THREE.Vector3());
      this.q('[data-print-dimensions]').textContent=`${Math.round(size.x)} × ${Math.round(size.y)} × ${Math.round(size.z)} mm at 100%`;
      this.q('[data-print-canvas]').setAttribute('aria-label',`${info.name}. Drag to rotate and scroll to zoom. Arrow keys rotate; plus and minus zoom; Home resets.`);
      this.status.hidden=true;this.setCameraEnabled(true);this.resize();this.frame('perspective');return true;
    } catch(error) {
      if(this.disposed||selection!==this.selection)return false;
      console.error(`Print preview (${mode}):`,error);
      this.showStatus('This preview could not load. Select this object again to retry, or choose another. Downloads remain available.');return false;
    }
  }
  frame(view='perspective') {
    if(!this.box||this.contextLost)return;
    const center=this.box.getCenter(new THREE.Vector3()).applyAxisAngle(new THREE.Vector3(1,0,0),-Math.PI/2);
    const size=this.box.getSize(new THREE.Vector3());
    const distance=Math.max(size.x,size.y,size.z)*2.5/Math.min(this.camera.aspect||1,1);
    const direction={perspective:[.85,.32,-1],front:[0,.08,-1],side:[1,.08,0],top:[0,1,-.001]}[view]||[.85,.32,-1];
    this.controls.target.copy(center);
    this.camera.position.copy(new THREE.Vector3(...direction).normalize().multiplyScalar(distance).add(center));
    this.camera.lookAt(center);this.controls.update();this.draw();
  }
  resize() {
    if(!this.renderer||!this.camera||this.disposed)return;
    const rect=this.q('[data-print-canvas]').getBoundingClientRect();
    if(rect.width<1||rect.height<1)return;
    const previous=this.camera.aspect;this.camera.aspect=rect.width/rect.height;this.camera.updateProjectionMatrix();
    this.renderer.setSize(rect.width,rect.height,false);
    if(Math.abs(previous-this.camera.aspect)>.01)this.frame();else this.draw();
  }
  keyboard(event) {
    if(!this.box||this.contextLost||!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','+','=','-','Home'].includes(event.key))return;
    event.preventDefault();if(event.key==='Home'){this.frame();return;}
    const spherical=new THREE.Spherical().setFromVector3(this.camera.position.clone().sub(this.controls.target));
    if(event.key==='ArrowLeft')spherical.theta-=.12;if(event.key==='ArrowRight')spherical.theta+=.12;
    if(event.key==='ArrowUp')spherical.phi-=.12;if(event.key==='ArrowDown')spherical.phi+=.12;
    if(['+','='].includes(event.key))spherical.radius*=.9;if(event.key==='-')spherical.radius*=1.1;
    spherical.radius=THREE.MathUtils.clamp(spherical.radius,90,1300);spherical.makeSafe();
    this.camera.position.copy(new THREE.Vector3().setFromSpherical(spherical).add(this.controls.target));this.controls.update();this.draw();
  }
  draw(){if(this.active&&!this.disposed&&!this.contextLost&&this.renderer&&this.scene)this.renderer.render(this.scene,this.camera);}
  destroy(){
    this.disposed=true;this.selection++;this.events.abort();this.observer?.disconnect();this.controls?.dispose();
    for(const mesh of Object.values(this.meshes)){mesh.geometry.dispose();mesh.material.dispose();}
    this.renderer?.dispose();this.renderer?.domElement.remove();
  }
}
