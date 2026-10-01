import {StatisticsModel} from './statistics-model.js?v=statistics-2';
const NS='http://www.w3.org/2000/svg';
export class Statistics {
  constructor(root,version) {
    this.root=root;this.version=version;this.modelName='brain';this.unit='mm';this.active=false;
    this.q=selector=>root.querySelector(selector);
    this.ready=this.initialize().catch(error=>{
      console.error('Statistics:',error);
      this.q('#statistics-status').hidden=false;
      this.q('#statistics-status').textContent='The measurements could not load. Reload the page to try again.';
    });
  }
  async initialize() {
    const response=await fetch(`./public/data/statistics.json?v=${this.version}`);
    if(!response.ok)throw new Error('Statistics data is unavailable');
    this.data=await response.json();
    for(const name of ['brain','head']) {
      const model=this.data.models?.[name];
      if(!model||!Object.values(model.dimensionsMm).every(value=>Number.isFinite(value)&&value>0)||!(model.enclosedModelVolumeMl>0))throw new Error('Invalid model measurements');
    }
    const contours=this.data.headContours;
    if(!contours?.levels?.length)throw new Error('Missing head outlines');
    this.q('#stats-contour-level').max=contours.levels.length-1;
    this.q('#stats-contour-level').value=contours.defaultIndex;
    this.root.querySelectorAll('[data-stats-object]').forEach(button=>button.addEventListener('click',()=>this.selectModel(button.dataset.statsObject)));
    this.root.querySelectorAll('[data-stats-unit]').forEach(button=>button.addEventListener('click',()=>this.setUnits(button.dataset.statsUnit)));
    this.root.querySelectorAll('[data-stats-view]').forEach(button=>button.addEventListener('click',()=>{
      this.root.querySelectorAll('[data-stats-view]').forEach(b=>b.setAttribute('aria-pressed',String(b===button)));
      this.viewer?.setView(button.dataset.statsView);
    }));
    for(const selector of ['#stats-contour-level','#stats-show-circle','#stats-show-box'])this.q(selector).addEventListener('input',()=>this.renderContour());
    this.q('#statistics-status').hidden=true;
    this.q('#statistics-content').hidden=false;
    this.viewer=new StatisticsModel(this.q('#statistics-model'),this.version);
    this.viewer.setActive(this.active);
    this.renderMeasurements();this.renderContour();
    this.q('#stats-source-record').textContent=`These measurements refer to the current model files: brain ${this.data.models.brain.sha256.slice(0,12)}… and head ${this.data.models.head.sha256.slice(0,12)}… (SHA-256). The contour display is simplified within ${contours.outlineSimplificationToleranceMm} mm; measurements use the full section.`;
  }
  setActive(active) {this.active=active;this.viewer?.setActive(active);}
  length(mm) {return this.unit==='cm'?`${(mm/10).toFixed(1)} cm`:`${Math.round(mm)} mm`;}
  setUnits(unit) {
    this.unit=unit;
    this.root.querySelectorAll('[data-stats-unit]').forEach(button=>button.setAttribute('aria-pressed',String(button.dataset.statsUnit===unit)));
    if(!this.data)return;
    this.viewer?.setUnits(unit);this.renderMeasurements();this.renderContour();
  }
  selectModel(name) {
    this.modelName=name;
    this.root.querySelectorAll('[data-stats-object]').forEach(button=>button.setAttribute('aria-pressed',String(button.dataset.statsObject===name)));
    this.viewer?.selectModel(name);this.renderMeasurements();
  }
  renderMeasurements() {
    const model=this.data.models[this.modelName],isBrain=this.modelName==='brain';
    for(const [key,value] of Object.entries(model.dimensionsMm))this.q(`[data-stats-value="${key}"]`).textContent=this.length(value);
    this.q('[data-stats-object-label]').textContent=isBrain?'HD-BET BRAIN MODEL':'CAPTURED HEAD MODEL';
    this.q('[data-stats-height-label]').textContent=isBrain?'Superior–inferior span':'Captured height';
    this.q('[data-stats-dimension-note]').textContent=isBrain?'Spans along the scan’s left–right, front–back and vertical axes. Head position and segmentation affect these estimates.':'Spans along the scan’s left–right, front–back and vertical axes. The model includes scalp and face; its lower boundary is cropped.';
    this.q('[data-stats-volume-label]').textContent=`Space enclosed by the ${isBrain?'brain':'captured head'} model`;
    this.q('[data-stats-volume]').textContent=`${(model.enclosedModelVolumeMl/1000).toFixed(2)} L`;
    this.q('[data-stats-volume-note]').textContent=isBrain?'The printable surface closes over internal spaces. This is not a measured gray + white matter tissue volume.':'This closed exterior includes internal spaces and the face. The cropped scan does not measure complete head volume or intracranial capacity.';
    this.q('[data-stats-proportion]').textContent=`${model.ratios.anteriorPosteriorToRightLeft.toFixed(2)}×`;
    this.q('[data-stats-sphere]').textContent=this.length(model.equivalentVolumeSphereDiameterMm);
  }
  renderContour() {
    const contours=this.data.headContours,index=Number(this.q('#stats-contour-level').value),level=contours.levels[index];
    const circle=level.equalAreaCircle,box=level.minimumAreaRectangle;
    this.q('[data-stats-elongation]').textContent=`${level.elongation.toFixed(2)}×`;
    this.q('[data-stats-contour-length]').textContent=this.length(box.lengthMm);
    this.q('[data-stats-contour-width]').textContent=this.length(box.widthMm);
    this.q('[data-stats-contour-area]').textContent=`${(level.areaMm2/100).toFixed(0)} cm²`;
    this.q('.stats-contour-legend>span:last-child').hidden=!this.q('#stats-show-circle').checked;
    this.q('#stats-contour-level-label').textContent=`${index+1} / ${contours.levels.length} · ${this.length(contours.zBandMm[1]-level.zMm)} below band top`;
    this.q('#stats-contour-level').setAttribute('aria-valuetext',`Section ${index+1} of ${contours.levels.length}, ${this.length(contours.zBandMm[1]-level.zMm)} below the top of the selected band`);
    this.q('[data-stats-contour-band]').textContent='The selected band spans 60–95% of the captured model’s height. The middle level is selected by default. This is a geometric band, not an anatomical landmark.';
    const svg=this.q('#stats-contour');svg.replaceChildren();
    const append=(tag,attrs={},text,parent=svg)=>{
      const el=document.createElementNS(NS,tag);for(const [key,value] of Object.entries(attrs))el.setAttribute(key,String(value));
      if(text!==undefined)el.textContent=text;parent.append(el);return el;
    };
    append('title',{id:'stats-contour-title'},`Upper head model outline at section ${index+1}. Enclosing length ${this.length(box.lengthMm)}, width ${this.length(box.widthMm)}. Length-to-width ratio ${level.elongation.toFixed(2)}. ${this.q('#stats-show-circle').checked?'The dashed circle encloses the same area.':'The circle comparison is hidden.'}`);
    // Keep scale fixed through the whole band so crown contours genuinely shrink.
    if(!this.contourFrame) {
      const points=contours.levels.flatMap(l=>[
        ...l.minimumAreaRectangle.cornersMm,
        [l.centroidMm[0]-l.equalAreaCircle.radiusMm,l.centroidMm[1]-l.equalAreaCircle.radiusMm],
        [l.centroidMm[0]+l.equalAreaCircle.radiusMm,l.centroidMm[1]+l.equalAreaCircle.radiusMm]
      ]);
      const xs=points.map(p=>p[0]),ys=points.map(p=>p[1]);
      const bounds=[Math.min(...xs),Math.min(...ys),Math.max(...xs),Math.max(...ys)];
      this.contourFrame={cx:(bounds[0]+bounds[2])/2,cy:(bounds[1]+bounds[3])/2,scale:Math.min(420/(bounds[2]-bounds[0]),315/(bounds[3]-bounds[1]))};
    }
    const {cx,cy,scale}=this.contourFrame;
    // Radiological top view: the person's right is screen-left; anterior is up.
    const transform=([x,y])=>[260-(x-cx)*scale,195-(y-cy)*scale];
    const path=points=>points.map((point,i)=>`${i?'L':'M'}${transform(point).map(v=>v.toFixed(2)).join(',')}`).join(' ')+' Z';
    const defs=append('defs'),pattern=append('pattern',{id:'stats-contour-grid',width:26,height:26,patternUnits:'userSpaceOnUse'},undefined,defs);
    append('path',{d:'M26 0H0V26',fill:'none',stroke:'#86aec0','stroke-width':.6,opacity:.12},undefined,pattern);
    append('rect',{x:0,y:0,width:520,height:430,fill:'url(#stats-contour-grid)'});
    append('path',{d:path(level.outlineMm),fill:'#7aa89828',stroke:'#b1dfc9','stroke-width':2.3,'stroke-linejoin':'round'});
    if(this.q('#stats-show-circle').checked) {
      const [x,y]=transform(circle.centerMm);
      append('circle',{cx:x,cy:y,r:circle.radiusMm*scale,fill:'none',stroke:'#8fb9ea','stroke-width':1.6,'stroke-dasharray':'6 6'});
    }
    if(this.q('#stats-show-box').checked)append('path',{d:path(box.cornersMm),fill:'none',stroke:'#dec58e','stroke-width':1.3,'stroke-dasharray':'3 4'});
    const label=(x,y,text,size=10)=>append('text',{x,y,'text-anchor':'middle',fill:'#a7c3d4','font-family':'system-ui, sans-serif','font-size':size},text);
    label(260,21,'ANTERIOR');label(260,397,'POSTERIOR');label(23,199,'R');label(497,199,'L');
    label(260,420,'MODEL SECTION · CONSTANT DISPLAY SCALE',9);
  }
}
