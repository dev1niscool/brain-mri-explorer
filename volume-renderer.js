import * as THREE from 'three';
import {OrbitControls} from './vendor/OrbitControls.js';

const DEFAULTS = Object.freeze({mode:'translucent', selection:'head', quality:'balanced', opacity:.45, floor:.05, ceiling:.6, cut:0});
const QUALITY = {low:{step:2.2, steps:192, ratio:1}, balanced:{step:1.15, steps:384, ratio:1.5}, high:{step:.65, steps:768, ratio:2}};

// This is an original ray marcher. The supplied grid is x-fastest RAS. Its
// physical edges are +/- dims*spacing/2; voxel i is at (i+.5)*spacing-extent/2.
// Display world coordinates are (R, S, -A), a rotation with no scale distortion.
const VERTEX = `
precision highp float;
in vec3 position;
out vec2 screenPosition;
void main() {
  screenPosition = position.xy;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}`;

const FRAGMENT = `
precision highp float;
precision highp int;
precision highp sampler3D;
in vec2 screenPosition;
out vec4 fragmentColor;
uniform sampler3D volume;
uniform sampler3D brainMask;
uniform mat4 inverseProjection;
uniform mat4 cameraWorld;
uniform vec3 extent;
uniform float stepMm;
uniform int maxSteps;
uniform int mode;
uniform bool brainOnly;
uniform float opacity;
uniform float floorValue;
uniform float ceilingValue;
uniform float cut;

vec3 worldToRAS(vec3 p) { return vec3(p.x, -p.z, p.y); }

// Parallel rays are handled explicitly, including those on a box face.
bool slab(float origin, float direction, float lo, float hi, inout float start, inout float end) {
  if (abs(direction) < 0.0000001) return origin >= lo && origin <= hi;
  float a = (lo-origin)/direction;
  float b = (hi-origin)/direction;
  start = max(start, min(a,b));
  end = min(end, max(a,b));
  return end > start;
}

float signalAt(vec3 positionRAS) {
  // Normalized 3D texture centers are (i+.5)/dims, exactly matching the
  // physical voxel centers above. No additional half-voxel offset is needed.
  vec3 uvw = positionRAS/extent + vec3(.5);
  if (brainOnly && texture(brainMask,uvw).r < .5) return 0.0;
  float value = texture(volume,uvw).r;
  return clamp((value-floorValue)/max(ceilingValue-floorValue, .0001), 0.0, 1.0);
}

vec3 palette(float value) {
  return mix(vec3(.65,.76,.80), vec3(.94,.99,.96), value);
}

void main() {
  if (cut >= 1.0 || opacity <= 0.0) discard;
  vec4 cameraRay = inverseProjection * vec4(screenPosition,1.0,1.0);
  vec3 origin = worldToRAS(cameraWorld[3].xyz);
  vec3 direction = normalize(worldToRAS(mat3(cameraWorld) * (cameraRay.xyz/cameraRay.w)));
  vec3 halfSize = extent*.5;
  float start = 0.0;
  float end = 1.0e20;
  // Remove patient-right first: the retained region is x <= +extent.x/2-cut*extent.x.
  if (!slab(origin.x,direction.x,-halfSize.x,halfSize.x-cut*extent.x,start,end)
   || !slab(origin.y,direction.y,-halfSize.y,halfSize.y,start,end)
   || !slab(origin.z,direction.z,-halfSize.z,halfSize.z,start,end)) discard;

  int count = int(clamp(ceil((end-start)/stepMm),1.0,float(maxSteps)));
  float distanceMm = (end-start)/float(count);
  float maximum = 0.0;
  float integral = 0.0;
  vec4 accumulated = vec4(0.0);
  // Extinction is per millimeter, so changing sample spacing does not change
  // opacity in a uniform medium. This is an illustrative transfer function.
  float extinction = -log(max(1.0-opacity*.995,.005))/18.0;
  for (int i=0; i<768; i++) {
    if (i >= count) break;
    float value = signalAt(origin + direction*(start+(float(i)+.5)*distanceMm));
    if (mode == 2) {
      maximum = max(maximum,value);
    } else if (mode == 1) {
      integral += value*distanceMm;
    } else if (value > 0.0) {
      float alpha = 1.0-exp(-value*extinction*distanceMm);
      float depthShade = .76+.24*(1.0-(float(i)+.5)/float(count));
      accumulated.rgb += (1.0-accumulated.a)*alpha*palette(value)*depthShade;
      accumulated.a += (1.0-accumulated.a)*alpha;
      if (accumulated.a > .995) break;
    }
  }
  if (mode == 2) {
    // Maximum intensity projection: the largest windowed signal on the ray.
    fragmentColor = vec4(palette(maximum),maximum*opacity);
  } else if (mode == 1) {
    // Artistic X-ray style: integrated MRI signal, normalized by the fixed
    // box diagonal. This is not a simulation of X-ray attenuation or density.
    float intensity = 1.0-exp(-integral/length(extent)*opacity*10.0);
    fragmentColor = vec4(palette(intensity),intensity);
  } else {
    fragmentColor = vec4(accumulated.rgb/max(accumulated.a,.00001),accumulated.a);
  }
  if (fragmentColor.a <= .00001) discard;
}`;

/** Standalone on-demand renderer; no data loading or UI settings are owned here. */
export class VolumeRenderer {
  constructor(holder, {onError, onInteraction} = {}) {
    this.holder = holder;
    this.onError = onError;
    this.onInteraction = onInteraction;
    this.settings = {...DEFAULTS};
    this.active = true;
    this.disposed = false;
    this.failed = false;
    this.hasData = false;
    this.interacting = false;
    this.frame = null;
    this.restoreTimer = null;
    this.width = 0;
    this.height = 0;
    this.events = new AbortController();
    try {
      if (!(holder instanceof HTMLElement)) throw new Error('The MRI volume needs a display container.');
      this.canvas = document.createElement('canvas');
      this.canvas.style.cssText = 'display:block;width:100%;height:100%;touch-action:none;outline-offset:-4px';
      this.canvas.tabIndex = 0;
      this.canvas.setAttribute('role','img');
      this.canvas.setAttribute('aria-label','3D MRI volume. Drag to rotate, scroll or pinch to zoom. Arrow keys rotate; plus and minus zoom; Home resets the camera.');
      const context = this.canvas.getContext('webgl2',{alpha:true,antialias:false,premultipliedAlpha:false,powerPreference:'low-power'});
      if (!context) throw new Error('3D MRI rendering requires WebGL 2. Try another browser or enable graphics acceleration.');
      this.renderer = new THREE.WebGLRenderer({canvas:this.canvas,context,alpha:true,antialias:false,premultipliedAlpha:false});
      this.renderer.setClearColor(0x000000,0);
      this.renderer.toneMapping = THREE.NoToneMapping;
      this.renderer.debug.onShaderError = () => { throw new Error('The MRI volume shader could not run on this graphics device.'); };
      this.maxTextureSize = context.getParameter(context.MAX_3D_TEXTURE_SIZE);
      holder.append(this.canvas);
      this.camera = new THREE.PerspectiveCamera(34,1,.1,10000);
      this.camera.position.set(-350,170,-530);
      this.controls = new OrbitControls(this.camera,this.canvas);
      this.controls.enableDamping = false;
      this.controls.enablePan = false;
      this.controls.rotateSpeed = .8;
      this.controls.addEventListener('change',() => this.requestDraw());
      this.controls.addEventListener('start',() => this.beginInteraction());
      this.controls.addEventListener('end',() => this.endInteraction());
      this.uniforms = {
        volume:{value:null},brainMask:{value:null},
        inverseProjection:{value:new THREE.Matrix4()},cameraWorld:{value:new THREE.Matrix4()},
        extent:{value:new THREE.Vector3(1,1,1)},stepMm:{value:1},maxSteps:{value:384},
        mode:{value:0},brainOnly:{value:false},opacity:{value:.45},floorValue:{value:.05},ceilingValue:{value:.6},cut:{value:0},
      };
      this.material = new THREE.RawShaderMaterial({glslVersion:THREE.GLSL3,vertexShader:VERTEX,fragmentShader:FRAGMENT,uniforms:this.uniforms,transparent:true,depthTest:false,depthWrite:false});
      this.geometry = new THREE.PlaneGeometry(2,2);
      this.quad = new THREE.Mesh(this.geometry,this.material);
      this.quad.frustumCulled = false;
      this.scene = new THREE.Scene();
      this.scene.add(this.quad);
      this.canvas.addEventListener('keydown',event => this.onKey(event),{signal:this.events.signal});
      this.canvas.addEventListener('webglcontextlost',event => {
        event.preventDefault();
        this.fail(new Error('The graphics context was lost. Reload this volume view to try again.'));
      },{signal:this.events.signal});
      document.addEventListener('visibilitychange',() => this.syncActive(),{signal:this.events.signal});
      this.observer = new ResizeObserver(() => this.resize());
      this.observer.observe(holder);
      this.syncActive();
      this.resize();
    } catch (error) { this.fail(error); }
  }

  /** mask is occupancy 0/1 (0/255 is also accepted); both arrays are x-fastest. */
  setData({values,mask,dims,spacing} = {}) {
    if (this.disposed) return false;
    try {
      if (!Array.isArray(dims) || dims.length !== 3 || dims.some(n => !Number.isInteger(n) || n < 1 || n > this.maxTextureSize)) throw new Error('The MRI dimensions exceed this graphics device’s 3D texture limits.');
      if (!Array.isArray(spacing) || spacing.length !== 3 || spacing.some(n => !Number.isFinite(n) || n <= 0)) throw new Error('The MRI voxel spacing is invalid.');
      const length = dims.reduce((a,b) => a*b,1);
      if (!Number.isSafeInteger(length) || !(values instanceof Uint8Array) || !(mask instanceof Uint8Array) || values.length !== length || mask.length !== length) throw new Error('The MRI and brain mask must have matching 8-bit voxel grids.');
      const binaryMask = new Uint8Array(length);
      const occupiedMin = [...dims], occupiedMax = [-1,-1,-1];
      // Ignore empty padding for camera framing only. Texture data, sampling,
      // mask, clipping and the physical ray box remain completely unchanged.
      let i = 0;
      for (let z=0; z<dims[2]; z++) for (let y=0; y<dims[1]; y++) for (let x=0; x<dims[0]; x++,i++) {
        binaryMask[i] = mask[i] > 0 ? 255 : 0;
        if (values[i] <= 255*.05) continue;
        occupiedMin[0] = Math.min(occupiedMin[0],x); occupiedMax[0] = Math.max(occupiedMax[0],x);
        occupiedMin[1] = Math.min(occupiedMin[1],y); occupiedMax[1] = Math.max(occupiedMax[1],y);
        occupiedMin[2] = Math.min(occupiedMin[2],z); occupiedMax[2] = Math.max(occupiedMax[2],z);
      }
      const makeTexture = data => {
        const texture = new THREE.Data3DTexture(data,...dims);
        texture.format = THREE.RedFormat;
        texture.type = THREE.UnsignedByteType;
        texture.internalFormat = 'R8';
        texture.minFilter = texture.magFilter = THREE.LinearFilter;
        texture.wrapS = texture.wrapT = texture.wrapR = THREE.ClampToEdgeWrapping;
        texture.unpackAlignment = 1;
        texture.generateMipmaps = false;
        texture.flipY = false;
        texture.needsUpdate = true;
        return texture;
      };
      const nextVolume = makeTexture(values);
      const nextMask = makeTexture(binaryMask);
      this.volumeTexture?.dispose();
      this.maskTexture?.dispose();
      this.volumeTexture = nextVolume;
      this.maskTexture = nextMask;
      this.uniforms.volume.value = nextVolume;
      this.uniforms.brainMask.value = nextMask;
      this.dims = [...dims];
      this.spacing = [...spacing];
      this.uniforms.extent.value.set(...dims.map((n,i) => n*spacing[i]));
      const hasSignal = occupiedMax[0] >= 0;
      const low = dims.map((n,axis) => ((hasSignal ? occupiedMin[axis] : 0)-n/2)*spacing[axis]);
      const high = dims.map((n,axis) => ((hasSignal ? occupiedMax[axis]+1 : n)-n/2)*spacing[axis]);
      this.fitBoundsRAS = new THREE.Box3(new THREE.Vector3(...low),new THREE.Vector3(...high));
      this.fitBoundsWorld = new THREE.Box3(new THREE.Vector3(low[0],low[2],-high[1]),new THREE.Vector3(high[0],high[2],-low[1]));
      this.fitCenter = this.fitBoundsWorld.getCenter(new THREE.Vector3());
      this.radius = this.fitBoundsWorld.getSize(new THREE.Vector3()).length()/2;
      this.camera.near = Math.max(.01,this.radius/2000);
      this.camera.far = this.radius*30;
      this.controls.minDistance = this.radius*.25;
      this.controls.maxDistance = this.radius*15;
      this.hasData = true;
      this.setCamera('angle');
      this.setSettings(this.settings);
      return true;
    } catch (error) { this.fail(error); return false; }
  }

  setSettings(settings = {}) {
    if (this.disposed) return;
    const next = {...this.settings};
    for (const [name,choices] of Object.entries({mode:['translucent','xray','mip'],selection:['head','brain'],quality:['low','balanced','high']})) {
      if (choices.includes(settings[name])) next[name] = settings[name];
    }
    for (const name of ['opacity','floor','ceiling','cut']) {
      if (Number.isFinite(settings[name])) next[name] = Math.max(0,Math.min(1,settings[name]));
    }
    // A zero-width or reversed display window must never divide by zero.
    next.floor = Math.min(next.floor,.9999);
    next.ceiling = Math.max(next.ceiling,next.floor+.0001);
    this.settings = next;
    this.uniforms.mode.value = ['translucent','xray','mip'].indexOf(next.mode);
    this.uniforms.brainOnly.value = next.selection === 'brain';
    this.uniforms.opacity.value = next.opacity;
    this.uniforms.floorValue.value = next.floor;
    this.uniforms.ceilingValue.value = next.ceiling;
    this.uniforms.cut.value = next.cut;
    this.requestDraw();
  }

  /** Camera-only reset; the owner keeps the settings UI and reset values in sync. */
  reset() { this.setCamera('angle'); }

  setCamera(view = 'angle') {
    if (this.disposed || !this.hasData) return;
    const directions = {front:[0,0,-1],side:[-1,0,0],top:[0,1,.0001],angle:[-.8,.42,-1.4]};
    if (!directions[view]) return;
    const direction = new THREE.Vector3(...directions[view]).normalize();
    const right = new THREE.Vector3().crossVectors(new THREE.Vector3(0,1,0),direction).normalize();
    const up = new THREE.Vector3().crossVectors(direction,right).normalize();
    const tanVertical = Math.tan(THREE.MathUtils.degToRad(this.camera.fov/2));
    const tanHorizontal = tanVertical*this.camera.aspect;
    const half = this.fitBoundsWorld.getSize(new THREE.Vector3()).multiplyScalar(.5);
    let distance = 0;
    // Fit all eight physical corners in perspective, including each corner's
    // depth. A small 4% screen margin avoids the old mostly-empty sphere fit.
    for (const x of [-half.x,half.x]) for (const y of [-half.y,half.y]) for (const z of [-half.z,half.z]) {
      const corner = new THREE.Vector3(x,y,z);
      const projected = Math.max(Math.abs(corner.dot(right))/tanHorizontal,Math.abs(corner.dot(up))/tanVertical)/.96;
      distance = Math.max(distance,corner.dot(direction)+projected);
    }
    this.controls.target.copy(this.fitCenter);
    this.camera.position.copy(direction).multiplyScalar(distance).add(this.fitCenter);
    this.camera.up.set(0,1,0);
    this.controls.update();
    this.camera.updateProjectionMatrix();
    this.requestDraw();
  }

  onKey(event) {
    if (!this.canDraw() || !this.hasData || event.altKey || event.ctrlKey || event.metaKey) return;
    const actions = {
      ArrowLeft:() => this.controls.rotateLeft(.12),ArrowRight:() => this.controls.rotateLeft(-.12),
      ArrowUp:() => this.controls.rotateUp(.12),ArrowDown:() => this.controls.rotateUp(-.12),
      '+':() => this.controls.dollyIn(.88),'=':() => this.controls.dollyIn(.88),
      '-':() => this.controls.dollyOut(.88),'_':() => this.controls.dollyOut(.88),Home:() => this.reset(),
    };
    if (!actions[event.key]) return;
    event.preventDefault();
    this.beginInteraction();
    actions[event.key]();
    this.endInteraction();
  }

  beginInteraction() {
    if (!this.canDraw()) return;
    clearTimeout(this.restoreTimer);
    this.interacting = true;
    this.onInteraction?.();
    this.requestDraw();
  }

  endInteraction() {
    clearTimeout(this.restoreTimer);
    if (!this.canDraw()) { this.interacting = false; return; }
    // Wheel start/end arrive in one event. Briefly retain cheaper rendering,
    // then request exactly one full-quality frame after interaction settles.
    this.restoreTimer = setTimeout(() => {
      this.restoreTimer = null;
      this.interacting = false;
      this.requestDraw();
    },140);
  }

  setActive(active) { this.active = Boolean(active); this.syncActive(); }

  canDraw() { return !this.disposed && this.active && !document.hidden; }

  syncActive() {
    if (this.disposed) return;
    const enabled = this.canDraw();
    this.controls.enabled = enabled;
    this.canvas.inert = !enabled;
    if (!enabled) {
      cancelAnimationFrame(this.frame);
      this.frame = null;
      clearTimeout(this.restoreTimer);
      this.restoreTimer = null;
      this.interacting = false;
    } else { this.resize(); this.requestDraw(); }
  }

  resize() {
    if (this.disposed) return;
    const width = Math.floor(this.holder.clientWidth);
    const height = Math.floor(this.holder.clientHeight);
    if (width <= 0 || height <= 0) return;
    this.width = width;
    this.height = height;
    this.camera.aspect = width/height;
    this.camera.updateProjectionMatrix();
    this.requestDraw();
  }

  requestDraw() {
    if (!this.canDraw() || !this.hasData || this.frame !== null) return;
    this.frame = requestAnimationFrame(() => { this.frame = null; this.draw(); });
  }

  draw() {
    if (!this.canDraw() || !this.hasData || !this.width || !this.height) return;
    try {
      const quality = QUALITY[this.settings.quality];
      const ratio = Math.min(globalThis.devicePixelRatio || 1,quality.ratio,2)*(this.interacting ? .6 : 1);
      if (this.renderer.getPixelRatio() !== ratio) this.renderer.setPixelRatio(ratio);
      const size = this.renderer.getSize(new THREE.Vector2());
      if (size.x !== this.width || size.y !== this.height) this.renderer.setSize(this.width,this.height,false);
      this.uniforms.stepMm.value = Math.min(...this.spacing)*(this.interacting ? Math.max(quality.step,3) : quality.step);
      this.uniforms.maxSteps.value = this.interacting ? Math.min(quality.steps,144) : quality.steps;
      this.camera.updateMatrixWorld();
      this.uniforms.inverseProjection.value.copy(this.camera.projectionMatrixInverse);
      this.uniforms.cameraWorld.value.copy(this.camera.matrixWorld);
      this.renderer.render(this.scene,this.camera);
      if (this.renderer.getContext().isContextLost()) throw new Error('The graphics context was lost while rendering the MRI.');
    } catch (error) { this.fail(error); }
  }

  fail(error) {
    if (this.disposed) return;
    this.failed = true;
    const callback = this.onError;
    this.dispose();
    if (callback) callback(error instanceof Error ? error : new Error(String(error)));
    else console.error('MRI volume renderer:',error);
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.active = false;
    cancelAnimationFrame(this.frame);
    clearTimeout(this.restoreTimer);
    this.frame = this.restoreTimer = null;
    this.events.abort();
    this.observer?.disconnect();
    this.controls?.dispose();
    this.volumeTexture?.dispose();
    this.maskTexture?.dispose();
    this.volumeTexture = this.maskTexture = null;
    if (this.uniforms) {
      this.uniforms.volume.value = null;
      this.uniforms.brainMask.value = null;
    }
    this.material?.dispose();
    this.geometry?.dispose();
    this.scene?.clear();
    if (this.renderer) {
      const lost = this.renderer.getContext().isContextLost();
      this.renderer.dispose();
      if (!lost) this.renderer.forceContextLoss();
    }
    this.canvas?.remove();
    this.hasData = false;
  }
}
