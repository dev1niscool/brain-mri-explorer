const DEFAULTS={mode:'translucent',selection:'head',quality:'balanced',opacity:.45,floor:.05,ceiling:.60,cut:0};
const MODE_NOTES={
  translucent:'Layers of MRI signal blend together into a see-through volume.',
  xray:'MRI signal adds up through the head. This is a projection effect, not an actual X-ray.',
  mip:'The brightest MRI signal along each viewing ray becomes the visible image.'
};

export class VolumeStudio {
  constructor(root,version) {
    this.root=root;this.version=version;this.active=false;this.ready=false;this.disposed=false;
    this.settings={...DEFAULTS};this.events=new AbortController();this.q=selector=>root.querySelector(selector);
    const on=(element,event,handler)=>element.addEventListener(event,handler,{signal:this.events.signal});
    root.querySelectorAll('[data-volume-selection]').forEach(button=>on(button,'click',()=>{
      this.settings.selection=button.dataset.volumeSelection;this.update();
    }));
    for(const key of ['mode','quality'])on(this.q(`#volume-${key}`),'change',()=>{
      this.settings[key]=this.q(`#volume-${key}`).value;this.update();
    });
    for(const key of ['opacity','floor','ceiling','cut'])on(this.q(`#volume-${key}`),'input',()=>{
      this.settings[key]=Number(this.q(`#volume-${key}`).value)/100;
      // Keep a nonzero intensity window while allowing either endpoint to move.
      if(key==='floor'&&this.settings.floor>=this.settings.ceiling)this.settings.ceiling=Math.min(1,this.settings.floor+.01);
      if(key==='ceiling'&&this.settings.ceiling<=this.settings.floor)this.settings.floor=Math.max(0,this.settings.ceiling-.01);
      this.update();
    });
    root.querySelectorAll('[data-volume-camera]').forEach(button=>on(button,'click',()=>this.renderer?.setCamera(button.dataset.volumeCamera)));
    on(this.q('#volume-reset'),'click',()=>{this.settings={...DEFAULTS};this.update();this.renderer?.reset();});
    on(this.q('#volume-retry'),'click',()=>this.initialize());
    this.update();this.initialize();
  }
  asset(file){return new URL(`./public/data/${file}?v=${encodeURIComponent(this.version)}`,document.baseURI);}
  async readVolume(file,expected,signal) {
    const response=await fetch(this.asset(file),{signal});
    if(!response.ok||!response.body)throw new Error('The MRI file could not load.');
    const bytes=new Uint8Array(await new Response(response.body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());
    if(bytes.length!==expected)throw new Error('The MRI dimensions do not match its data.');
    return bytes;
  }
  async initialize() {
    this.loading?.abort();const loading=this.loading=new AbortController();
    this.renderer?.dispose();this.renderer=null;this.ready=false;
    this.root.setAttribute('aria-busy','true');this.showStatus('Loading your MRI volume…');this.q('#volume-retry').hidden=true;this.enable(false);
    try {
      if(typeof DecompressionStream==='undefined')throw new Error('This viewer needs a browser with gzip decompression support.');
      const response=await fetch(this.asset('manifest.json'),{signal:loading.signal});
      if(!response.ok)throw new Error('The MRI description could not load.');
      const manifest=await response.json(),source=manifest.series?.find(series=>series.id==='t1-axial'),mask=manifest.brainMask;
      if(source?.file!=='t1-axial.raw.gz'||mask?.file!=='brain-mask.raw.gz'||mask.series!==source.id)throw new Error('The MRI and brain mask do not match.');
      if(!Array.isArray(source.dims)||source.dims.length!==3||!source.dims.every(n=>Number.isInteger(n)&&n>0&&n<=512))throw new Error('The volume dimensions are invalid.');
      for(const key of ['dims','spacing','origin'])if(JSON.stringify(source[key])!==JSON.stringify(mask[key]))throw new Error('The brain mask is not aligned to this MRI.');
      if(!source.spacing.every(n=>Number.isFinite(n)&&n>0))throw new Error('The volume spacing is invalid.');
      const count=source.dims.reduce((a,b)=>a*b,1);
      const [values,brainMask,{VolumeRenderer}]=await Promise.all([
        this.readVolume(source.file,count,loading.signal),this.readVolume(mask.file,count,loading.signal),
        import('./volume-renderer.js?v='+encodeURIComponent(this.version))
      ]);
      if(loading.signal.aborted||this.disposed)return;
      if(brainMask.some(value=>value!==0&&value!==1))throw new Error('The brain mask is invalid.');
      this.renderer=new VolumeRenderer(this.q('[data-volume-canvas]'),{onError:error=>this.fail(error)});
      if(this.renderer.failed||!this.renderer.setData({values,mask:brainMask,dims:source.dims,spacing:source.spacing}))return;
      this.renderer.setSettings(this.settings);this.renderer.setActive(this.active);
      this.ready=true;this.enable(true);this.q('#volume-status').hidden=true;this.root.setAttribute('aria-busy','false');
      this.q('[data-volume-sampling]').textContent=`${source.sourceSlices} acquired planes · ${source.sliceThickness} mm slices`;
      this.update();
    }catch(error){if(loading.signal.aborted||this.disposed)return;this.fail(error);}
  }
  showStatus(message){this.q('#volume-status').hidden=false;this.q('#volume-status-text').textContent=message;}
  fail(error){
    console.error('Volume Studio:',error);this.ready=false;this.enable(false);this.renderer?.setActive(false);
    this.showStatus('The 3D volume could not open. Try again, or use a browser with WebGL 2 support.');
    this.q('#volume-retry').hidden=false;this.root.setAttribute('aria-busy','false');
  }
  enable(ready){this.root.querySelectorAll('[data-volume-control]').forEach(control=>{control.disabled=!ready;});}
  update(){
    for(const key of ['mode','quality'])this.q(`#volume-${key}`).value=this.settings[key];
    for(const key of ['opacity','floor','ceiling','cut']){
      const value=Math.round(this.settings[key]*100);this.q(`#volume-${key}`).value=value;
      this.q(`#volume-${key}-value`).textContent=key==='cut'&&value===0?'Whole':key==='cut'&&value===100?'Fully cut':`${value}%`;
    }
    this.root.querySelectorAll('[data-volume-selection]').forEach(button=>button.setAttribute('aria-pressed',String(button.dataset.volumeSelection===this.settings.selection)));
    this.q('#volume-mode-note').textContent=MODE_NOTES[this.settings.mode];
    this.q('#volume-mask-note').hidden=this.settings.selection!=='brain';
    this.q('#volume-empty-note').hidden=this.settings.cut<1&&this.settings.opacity>0;
    this.q('#volume-empty-note').textContent=this.settings.cut>=1?'The cut has passed through the whole volume. Move it back to reveal the scan.':'Opacity is zero. Raise it to reveal the scan.';
    if(this.ready)this.renderer?.setSettings(this.settings);
  }
  setActive(active){this.active=Boolean(active);this.renderer?.setActive(this.active);}
  dispose(){this.disposed=true;this.loading?.abort();this.events.abort();this.renderer?.dispose();}
}
