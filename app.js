import {PrintIntro} from './print-intro.js?v=protected-nifti-1';

const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const ASSET_VERSION = 'protected-nifti-1';
const VIEW_IDS = ['brain2print','slices','volume','print','statistics'];
const resolveView = view => VIEW_IDS.includes(view) ? view : 'brain2print';
let activeView='brain2print', manifest, manifestError;
let sliceStudio, sliceStudioPromise, printStudio, printStudioPromise, statistics, statisticsPromise, volumeStudio, volumeStudioPromise;
let brain2printStarted=false, brain2printExtras, brain2printExtrasPromise, printPreviewStarted=false;
const printIntro = new PrintIntro($('.print-stage'));

function revealActiveTab() {
  const nav=$('.tabs'),tab=$('.tab.active');
  if(tab&&nav.scrollWidth>nav.clientWidth)nav.scrollLeft+=tab.getBoundingClientRect().left-nav.getBoundingClientRect().left-(nav.clientWidth-tab.offsetWidth)/2;
}
window.addEventListener('resize',revealActiveTab);
new ResizeObserver(revealActiveTab).observe($('.tabs'));

async function navigate(view) {
  view=resolveView(view);activeView=view;
  $$('.tab').forEach(button=>{
    button.classList.toggle('active',button.dataset.view===view);
    button.setAttribute('aria-pressed',String(button.dataset.view===view));
  });
  $$('.view').forEach(section=>{
    section.hidden=section.id!==`view-${view}`;
    section.classList.toggle('active',!section.hidden);
  });
  history.replaceState(null,'',`#${view}`);
  revealActiveTab();

  printIntro.setActive(view==='print');
  printStudio?.setActive(view==='print');
  if(view==='print') {
    if(!printPreviewStarted) {
      printPreviewStarted=true;
      // The captured-head image is already rendered; no extra 3D scene is needed.
      printIntro.setPreview(`./public/images/captured-head-preview.png?v=${ASSET_VERSION}`);
    }
    if(!printStudioPromise) {
      printStudioPromise=import('./print-studio.js?v='+ASSET_VERSION).then(({PrintStudio})=>{
        printStudio=new PrintStudio($('#print-studio'),ASSET_VERSION);
        printStudio.setActive(activeView==='print');
      }).catch(error=>{
        console.error('Print studio could not load',error);
        const status=$('[data-print-status]');
        status.hidden=false;status.textContent='The preview could not load. The STL downloads below remain available.';
        printStudioPromise=null;
      });
    }
  }

  volumeStudio?.setActive(view==='volume');
  if(view==='volume'&&!volumeStudioPromise) {
    volumeStudioPromise=import('./volume.js?v='+ASSET_VERSION).then(({VolumeStudio})=>{
      volumeStudio=new VolumeStudio($('#volume-studio'),ASSET_VERSION);
      volumeStudio.setActive(activeView==='volume');
    }).catch(error=>{
      console.error('Volume Studio could not load',error);
      $('#volume-studio').setAttribute('aria-busy','false');
      $('#volume-status').hidden=false;
      $('#volume-status-text').textContent='Volume Studio could not load. Reopen this tab to try again.';
      volumeStudioPromise=null;
    });
  }

  statistics?.setActive(view==='statistics');
  if(view==='statistics'&&!statisticsPromise) {
    statisticsPromise=import('./statistics.js?v='+ASSET_VERSION).then(({Statistics})=>{
      statistics=new Statistics($('#view-statistics'),ASSET_VERSION);
      statistics.setActive(activeView==='statistics');
    }).catch(error=>{
      console.error('Statistics could not load',error);
      $('#statistics-status').textContent='The statistics could not load. Reopen this tab to try again.';
      statisticsPromise=null;
    });
  }

  if(view!=='slices')sliceStudio?.pause?.();
  if(view==='slices'&&!manifest)$('#slice-workspace').textContent=manifestError||'Loading the MRI series…';
  if(view==='slices'&&manifest&&!sliceStudio&&!sliceStudioPromise) {
    sliceStudioPromise=import('./slices.js?v='+ASSET_VERSION).then(({SliceStudio})=>{
      if(activeView==='slices')sliceStudio=new SliceStudio($('#slice-workspace'),manifest);
    }).catch(error=>{
      console.error('Slice Studio could not load',error);
      $('#slice-workspace').textContent='Slice Studio could not load. Reopen this tab to try again.';
    }).finally(()=>{sliceStudioPromise=null;});
  }

  brain2printExtras?.setActive(view==='brain2print');
  if(view==='brain2print') {
    if(!brain2printExtrasPromise) {
      brain2printExtrasPromise=import('./brain2print-extras.js?v='+ASSET_VERSION).then(({Brain2PrintExtras})=>{
        brain2printExtras=new Brain2PrintExtras($('#view-brain2print'),ASSET_VERSION);
        brain2printExtras.setActive(activeView==='brain2print');
      }).catch(error=>{
        console.error('Brain2Print extras could not load',error);
        const status=$('#b2p-extras-status');
        if(status){status.hidden=false;status.textContent='The additional context view could not load. Reopen this tab to try again.';}
        brain2printExtrasPromise=null;
      });
    }
    const frame=$('#brain2print-frame');
    if(!brain2printStarted) {
      brain2printStarted=true;
      window.addEventListener('message',event=>{
        if(event.origin===location.origin&&event.source===frame.contentWindow&&event.data?.type==='brain2print:height'&&Number.isFinite(event.data.height))frame.style.height=Math.max(620,Math.min(2200,event.data.height))+'px';
      });
      const frameUrl=new URL(frame.dataset.src,location.href);
      frameUrl.searchParams.set('v',ASSET_VERSION);frame.src=frameUrl.href;
      import('./brain2print-story.js?v='+ASSET_VERSION).then(({initializeStory})=>initializeStory($('#brain2print-story'))).catch(error=>console.error('Brain2Print story could not load',error));
    } else frame.contentWindow?.postMessage({type:'brain2print:resize'},location.origin);
  }
}

$$('.tab').forEach(button=>button.addEventListener('click',()=>navigate(button.dataset.view)));
$$('[data-go]').forEach(button=>button.addEventListener('click',()=>navigate(button.dataset.go)));
window.addEventListener('hashchange',()=>navigate(location.hash.slice(1)));
$('.skip-link').addEventListener('click',event=>{
  event.preventDefault();const main=$('#main');main.tabIndex=-1;
  main.focus({preventScroll:true});main.scrollIntoView({block:'start'});
});
const about=$('#about-dialog');
$$('.about-trigger').forEach(button=>button.addEventListener('click',()=>about.showModal()));
$('#close-about').addEventListener('click',()=>about.close());
about.addEventListener('click',event=>{
  if(event.target!==about)return;
  const rect=about.getBoundingClientRect();
  if(event.clientX<rect.left||event.clientX>rect.right||event.clientY<rect.top||event.clientY>rect.bottom)about.close();
});

async function boot() {
  // Each 3D workspace can open independently of the Slice Studio manifest.
  await navigate(location.hash.slice(1));
  try {
    const response=await fetch(`./public/data/manifest.json?v=${ASSET_VERSION}`);
    if(!response.ok)throw new Error('Imaging manifest could not load');
    const data=await response.json();
    if(!Array.isArray(data.series)||!data.series.length)throw new Error('No MRI series are available');
    manifest=data;
    if(activeView==='slices')await navigate('slices');
  } catch(error) {
    console.error('MRI series could not load',error);
    manifestError='The imaging data is unavailable. Please reload the page.';
    $('#slice-workspace').textContent=manifestError;
  }
}
boot();
