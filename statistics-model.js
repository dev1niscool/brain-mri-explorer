import * as THREE from 'three';
import {STLLoader} from './vendor/STLLoader.js';
import {mergeVertices} from './vendor/BufferGeometryUtils.js';

const NS='http://www.w3.org/2000/svg';
const VIEWS={
  front:{direction:[0,0,-1],up:[0,1,0],horizontal:'R–L width',vertical:'S–I height',axes:['x','z']},
  side:{direction:[1,0,0],up:[0,1,0],horizontal:'A–P length',vertical:'S–I height',axes:['y','z']},
  top:{direction:[0,1,0],up:[0,0,-1],horizontal:'R–L width',vertical:'A–P length',axes:['x','y']},
};

/** Static orthographic measurements of the exported model's axis-aligned bounds.
 * ready resolves to true/false after the initial brain load; errors are visible.
 * Public setters can be called before ready. No anatomical landmarks are inferred.
 */
export class StatisticsModel {
  constructor(root,version='') {
    this.root=root;this.version=version;this.model='brain';this.view='front';this.units='mm';
    this.active=false;this.disposed=false;this.meshes=new Map();this.loads=new Map();
    this.holder=root.querySelector('[data-stats-model-canvas]');
    this.status=root.querySelector('[data-stats-model-status]');
    if(!this.holder||!this.status)throw new Error('StatisticsModel requires its canvas holder and status element.');
    this.status.setAttribute('role','status');
    this.ready=this.initialize().catch(error=>{this.showError(error);return false;});
  }

  async initialize() {
    this.setStatus('Loading the brain model…');
    if(getComputedStyle(this.holder).position==='static')this.holder.style.position='relative';
    this.renderer=new THREE.WebGLRenderer({antialias:true,alpha:true,powerPreference:'low-power'});
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio||1,2));
    this.renderer.outputColorSpace=THREE.SRGBColorSpace;
    this.renderer.toneMapping=THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure=1;
    this.renderer.setClearColor(0x000000,0);
    Object.assign(this.renderer.domElement.style,{position:'absolute',inset:'0',width:'100%',height:'100%',display:'block'});
    this.holder.setAttribute('role','img');
    this.renderer.domElement.setAttribute('aria-hidden','true');
    this.renderer.domElement.addEventListener('webglcontextlost',this.contextLost=event=>{
      event.preventDefault();this.contextUnavailable=true;
      this.setStatus('The measurement view was interrupted. Reload the page to restore it.');
    });
    this.holder.append(this.renderer.domElement);
    this.overlay=document.createElementNS(NS,'svg');
    this.overlay.setAttribute('aria-hidden','true');
    Object.assign(this.overlay.style,{position:'absolute',inset:'0',width:'100%',height:'100%',pointerEvents:'none',overflow:'hidden'});
    this.holder.append(this.overlay);
    this.scene=new THREE.Scene();
    this.camera=new THREE.OrthographicCamera(-150,150,150,-150,.1,4000);
    this.group=new THREE.Group();this.group.rotation.x=-Math.PI/2;this.scene.add(this.group);
    this.scene.add(new THREE.HemisphereLight(0xfff4ed,0x314a60,2));
    for(const [color,intensity,position] of [[0xfff0e8,2.3,[-220,320,-270]],[0xd9f3f0,.8,[250,50,-60]],[0xe0edff,1.2,[20,120,250]]]) {
      const light=new THREE.DirectionalLight(color,intensity);light.position.set(...position);this.scene.add(light);
    }
    this.observer=new ResizeObserver(()=>this.repaint());this.observer.observe(this.holder);
    return this.selectModel(this.model);
  }

  setStatus(message) {
    if(this.disposed)return;
    this.status.textContent=message;this.status.hidden=!message;
  }

  showError(error) {
    if(this.disposed)return;
    console.error('Statistics model:',error);
    this.setStatus(this.group?'The measurement model could not load. Select it again to retry, or reload the page.':'The measurement viewer could not initialize. Reload the page to retry; the numerical statistics remain available.');
  }

  loadModel(name) {
    if(this.meshes.has(name))return Promise.resolve(this.meshes.get(name));
    if(this.loads.has(name))return this.loads.get(name);
    const promise=(async()=>{
      const raw=await new STLLoader().loadAsync(`./public/data/${name}.stl?v=${encodeURIComponent(this.version)}`);
      raw.deleteAttribute('normal');
      const geometry=mergeVertices(raw,.001);raw.dispose();
      geometry.computeVertexNormals();geometry.computeBoundingBox();
      const material=new THREE.MeshStandardMaterial({color:name==='brain'?0xcf9693:0xc4af9f,roughness:.7,metalness:.015});
      const mesh=new THREE.Mesh(geometry,material);mesh.visible=false;
      if(this.disposed){geometry.dispose();material.dispose();return null;}
      this.meshes.set(name,mesh);this.group.add(mesh);
      return mesh;
    })().finally(()=>this.loads.delete(name));
    this.loads.set(name,promise);
    return promise;
  }

  async selectModel(name) {
    if(!['brain','head'].includes(name))throw new TypeError('Model must be brain or head.');
    this.model=name;
    if(this.disposed||!this.group)return false;
    if(this.contextUnavailable){this.setStatus('The measurement view was interrupted. Reload the page to restore it.');return false;}
    this.mesh=null;
    for(const mesh of this.meshes.values())mesh.visible=false;
    this.overlay.replaceChildren();
    if(this.active&&!this.contextUnavailable)this.renderer.render(this.scene,this.camera);
    this.setStatus(`Loading the ${name==='brain'?'brain':'captured head'} model…`);
    try {
      const mesh=await this.loadModel(name);
      if(this.disposed||this.model!==name||!mesh)return false;
      mesh.visible=true;this.mesh=mesh;this.setStatus('');this.repaint();
      return true;
    } catch(error) {
      if(this.model===name)this.showError(error);
      return false;
    }
  }

  setActive(active) {this.active=Boolean(active);if(this.active)this.repaint();}
  setView(view) {
    if(!Object.hasOwn(VIEWS,view))throw new TypeError('View must be front, side or top.');
    this.view=view;this.repaint();
  }
  setUnits(units) {
    if(!['mm','cm'].includes(units))throw new TypeError('Units must be mm or cm.');
    this.units=units;this.repaint();
  }
  format(mm) {return this.units==='cm'?`${(mm/10).toFixed(1)} cm`:`${Math.round(mm)} mm`;}

  repaint() {
    if(!this.active||this.disposed||this.contextUnavailable||!this.mesh||!this.renderer)return;
    const {width,height}=this.holder.getBoundingClientRect();
    if(width<80||height<100)return;
    const view=VIEWS[this.view],box=this.mesh.geometry.boundingBox,size=box.getSize(new THREE.Vector3());
    // Fit the exact span to the drawable rectangle, reserving CSS pixels for
    // the bottom/right rulers. The frustum offset keeps these margins constant.
    const margins={left:24,right:69,top:85,bottom:110};
    const usableWidth=Math.max(30,width-margins.left-margins.right);
    const usableHeight=Math.max(30,height-margins.top-margins.bottom);
    const mmPerPixel=Math.max(size[view.axes[0]]/usableWidth,size[view.axes[1]]/usableHeight)*1.035;
    const cx=margins.left+usableWidth/2,cy=margins.top+usableHeight/2;
    this.camera.left=-cx*mmPerPixel;this.camera.right=(width-cx)*mmPerPixel;
    this.camera.top=cy*mmPerPixel;this.camera.bottom=-(height-cy)*mmPerPixel;
    this.group.updateMatrixWorld(true);
    const center=box.getCenter(new THREE.Vector3()).applyMatrix4(this.group.matrixWorld);
    this.camera.up.set(...view.up);
    this.camera.position.copy(center).addScaledVector(new THREE.Vector3(...view.direction),size.length()*2+100);
    this.camera.lookAt(center);this.camera.updateProjectionMatrix();this.camera.updateMatrixWorld(true);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio||1,2));
    this.renderer.setSize(width,height,false);this.renderer.render(this.scene,this.camera);
    const corners=[];
    for(const x of [box.min.x,box.max.x])for(const y of [box.min.y,box.max.y])for(const z of [box.min.z,box.max.z]) {
      const p=new THREE.Vector3(x,y,z).applyMatrix4(this.group.matrixWorld).project(this.camera);
      corners.push([(p.x+1)*width/2,(1-p.y)*height/2]);
    }
    const bounds={left:Math.min(...corners.map(p=>p[0])),right:Math.max(...corners.map(p=>p[0])),
      top:Math.min(...corners.map(p=>p[1])),bottom:Math.max(...corners.map(p=>p[1]))};
    this.drawRulers(width,height,bounds,view,size);
    this.holder.setAttribute('aria-label',`${this.view} view of the ${this.model==='brain'?'brain':'captured head'} model. Axis-aligned model extents: ${view.horizontal}, ${this.format(size[view.axes[0]])}; ${view.vertical}, ${this.format(size[view.axes[1]])}. These are model dimensions, not anatomical landmark measurements.`);
  }

  drawRulers(width,height,b,view,size) {
    this.overlay.setAttribute('viewBox',`0 0 ${width} ${height}`);this.overlay.replaceChildren();
    const append=(tag,attributes,text)=>{
      const node=document.createElementNS(NS,tag);
      for(const [key,value] of Object.entries(attributes))node.setAttribute(key,String(value));
      if(text!==undefined)node.textContent=text;
      this.overlay.append(node);return node;
    };
    const stroke='#9cc9c2',muted='#749bab';
    const line=(x1,y1,x2,y2,extra={})=>append('line',{x1,y1,x2,y2,stroke,'stroke-width':1.2,...extra});
    const label=(x,y,text,extra={})=>append('text',{x,y,fill:'#d5e7ed','font-size':12,'font-weight':550,
      'font-family':'system-ui, -apple-system, sans-serif','text-anchor':'middle',
      style:'paint-order:stroke;stroke:#0d1928;stroke-width:4px;stroke-linejoin:round',...extra},text);
    append('rect',{x:b.left,y:b.top,width:b.right-b.left,height:b.bottom-b.top,fill:'none',stroke:'#83adbf35','stroke-width':1,'stroke-dasharray':'3 5'});
    const hy=b.bottom+24,vx=b.right+25;
    line(b.left,hy,b.right,hy);line(b.left,hy-5,b.left,hy+5);line(b.right,hy-5,b.right,hy+5);
    line(b.left,b.bottom+6,b.left,hy-8,{stroke:muted,opacity:.55});line(b.right,b.bottom+6,b.right,hy-8,{stroke:muted,opacity:.55});
    label((b.left+b.right)/2,hy+20,`${view.horizontal} · ${this.format(size[view.axes[0]])}`);
    line(vx,b.top,vx,b.bottom);line(vx-5,b.top,vx+5,b.top);line(vx-5,b.bottom,vx+5,b.bottom);
    line(b.right+6,b.top,vx-8,b.top,{stroke:muted,opacity:.55});line(b.right+6,b.bottom,vx-8,b.bottom,{stroke:muted,opacity:.55});
    const textX=vx+21,textY=(b.top+b.bottom)/2;
    label(textX,textY,`${view.vertical} · ${this.format(size[view.axes[1]])}`,{transform:`rotate(-90 ${textX} ${textY})`,'dominant-baseline':'middle'});
  }

  dispose() {
    if(this.disposed)return;this.disposed=true;this.active=false;this.observer?.disconnect();
    for(const mesh of this.meshes.values()){mesh.geometry.dispose();mesh.material.dispose();}
    this.meshes.clear();this.overlay?.remove();
    if(this.renderer){this.renderer.domElement.removeEventListener('webglcontextlost',this.contextLost);this.renderer.dispose();this.renderer.domElement.remove();}
  }
}
