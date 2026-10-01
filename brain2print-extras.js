/** Context viewer and print preparation for the saved Brain2Print result. */
export function printDimensions(dimensions, percent) {
  if (!Array.isArray(dimensions) || dimensions.length !== 3 || !dimensions.every(n => Number.isFinite(n) && n > 0) || !Number.isFinite(percent) || percent <= 0) throw new Error('Invalid print dimensions.');
  return dimensions.map(n => Math.round(n * percent / 100));
}

export class Brain2PrintExtras {
  constructor(root, version) {
    this.root = root; this.version = version; this.active = false; this.nearViewport = false; this.started = false;
    this.events = new AbortController();
    this.frame = root.querySelector('#brain2print-context-frame');
    this.section = root.querySelector('#b2p-inside');
    this.status = root.querySelector('#b2p-extras-status');
    this.retry = root.querySelector('#b2p-context-retry');
    this.scale = root.querySelector('#b2p-print-scale');
    this.dimensions = [141.031, 161.698, 121.939];
    const on = (target, type, callback) => target.addEventListener(type, callback, { signal: this.events.signal });
    on(this.scale, 'input', () => this.updateScale());
    on(this.retry, 'click', () => { this.started = false; this.ensureContext(); });
    for (const button of root.querySelectorAll('[data-b2p-jump]')) on(button, 'click', () => {
      const target = root.querySelector(`#${button.dataset.b2pJump}`);
      if (!target) return;
      if (target === this.section) this.ensureContext();
      target.querySelector('h2')?.focus({ preventScroll: true });
      target.scrollIntoView({ block: 'start', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
    });
    on(window, 'message', event => {
      if (event.origin !== location.origin || event.source !== this.frame.contentWindow) return;
      if (['brain2print-context:ready', 'brain2print-context:error'].includes(event.data?.type)) {
        clearTimeout(this.loadTimer); this.status.hidden = true; this.retry.hidden = true;
      }
      if (event.data?.type === 'brain2print-context:height' && Number.isFinite(event.data.height)) {
        this.frame.style.height = `${Math.max(400, Math.min(1600, Math.ceil(event.data.height)))}px`;
      }
    });
    on(this.frame, 'load', () => {
      this.frame.contentWindow?.postMessage({ type: 'brain2print-context:active', active: this.active }, location.origin);
      this.frame.contentWindow?.postMessage({ type: 'brain2print-context:resize' }, location.origin);
    });
    on(this.frame, 'error', () => {
      clearTimeout(this.loadTimer);
      this.status.hidden = false; this.status.textContent = 'The MRI cutaway could not load. Please try again.';
      this.retry.hidden = false;
    });
    this.observer = new IntersectionObserver(entries => {
      this.nearViewport = entries.some(entry => entry.isIntersecting);
      if (this.active && this.nearViewport) this.ensureContext();
    }, { rootMargin: '250px 0px' });
    this.observer.observe(this.section);
    this.updateScale(); this.loadPrintEditions();
  }

  setActive(active) {
    this.active = Boolean(active);
    if (this.active && this.nearViewport) this.ensureContext();
    if (this.started) this.frame.contentWindow?.postMessage({ type: 'brain2print-context:active', active: this.active }, location.origin);
  }

  ensureContext() {
    if (this.started || !this.active) return;
    this.started = true; this.retry.hidden = true;
    const url = new URL(this.frame.dataset.src, document.baseURI); url.searchParams.set('v', this.version);
    this.status.textContent = 'Loading the brain inside its MRI…'; this.status.hidden = false;
    clearTimeout(this.loadTimer);
    this.loadTimer = setTimeout(() => {
      this.status.hidden = false; this.status.textContent = 'The MRI cutaway is taking longer than expected. You can keep waiting or try again.';
      this.retry.hidden = false;
    }, 45000);
    this.frame.hidden = false; this.frame.src = url.href;
  }

  updateScale() {
    const percent = Number(this.scale.value);
    this.root.querySelector('#b2p-scale-value').textContent = `${percent}%`;
    this.root.querySelector('#b2p-print-dimensions').textContent = `${printDimensions(this.dimensions, percent).join(' × ')} mm`;
    this.scale.setAttribute('aria-valuetext', `${percent} percent of the original model size`);
  }

  async loadPrintEditions() {
    const note = this.root.querySelector('#b2p-print-verification');
    try {
      const url = new URL('public/data/b2p-print-editions.json', document.baseURI); url.searchParams.set('v', this.version);
      const response = await fetch(url, { signal: this.events.signal });
      if (!response.ok) throw new Error('Print details unavailable.');
      const metadata = await response.json();
      if (metadata.version !== 1 || !Array.isArray(metadata.editions)) throw new Error('Invalid print details.');
      for (const id of ['full', 'compact']) {
        const edition = metadata.editions.find(entry => entry.id === id);
        if (!edition || !Number.isInteger(edition.triangles) || edition.triangles <= 0 || !Number.isFinite(edition.bytes) || edition.bytes <= 0) throw new Error('Invalid print edition.');
        const count = this.root.querySelector(`[data-b2p-${id}-triangles]`);
        const suffix = document.createElement('small'); suffix.textContent = 'triangles';
        count.replaceChildren(document.createTextNode(edition.triangles.toLocaleString('en-US') + ' '), suffix);
        this.root.querySelector(`[data-b2p-${id}-size]`).textContent = `${(edition.bytes / 1e6).toFixed(1)} MB · Original millimeter scale`;
      }
      const full = metadata.editions.find(entry => entry.id === 'full');
      const compact = metadata.editions.find(entry => entry.id === 'compact');
      printDimensions(full.dimensionsMm, 100); this.dimensions = full.dimensionsMm; this.updateScale();
      this.root.querySelector('[data-b2p-density]').style.width = `${Math.min(100, compact.triangles / full.triangles * 100)}%`;
      const checked = [full, compact].every(edition => edition.watertight === true && edition.windingConsistent === true && edition.connectedComponents === 1);
      if (!checked || !Number.isFinite(compact.surfaceDeviation?.p95Mm) || !Number.isFinite(compact.surfaceDeviation?.maximumSampledMm)) throw new Error('Mesh checks unavailable.');
      const reduction = Math.round((1 - compact.triangles / full.triangles) * 100);
      note.textContent = `Compact uses ${reduction}% fewer triangles. In a two-way surface comparison, 95% of sampled distances were within ${compact.surfaceDeviation.p95Mm.toFixed(3)} mm; the largest sampled difference was ${compact.surfaceDeviation.maximumSampledMm.toFixed(2)} mm. Both files have one connected surface and closed edges. These checks compare meshes; they do not validate anatomical accuracy.`;
    } catch (error) {
      if (error.name === 'AbortError') return;
      note.textContent = 'Detailed mesh checks could not load. Dimensions are approximate; the STL files and print notes remain available.';
    }
  }

  destroy() { clearTimeout(this.loadTimer); this.events.abort(); this.observer.disconnect(); this.setActive(false); }
}
