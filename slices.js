import { parseNativeNifti, createLinkedGrid, renderLinkedPlane } from './linked-volume.js?v=protected-nifti-1';

const ASSET_VERSION = new URL(import.meta.url).searchParams.get('v') || 'protected-nifti-1';

export function sliceAssetUrl(file) {
  const url = new URL(`public/data/${file}`, document.baseURI);
  url.searchParams.set('v', ASSET_VERSION);
  return url;
}

/** A reversible 2D display transform; the volume and its patient axes stay unchanged. */
export function getSliceDisplayTransform(width, height, physicalWidth, physicalHeight, angleDegrees = 0, padding = 0) {
  const radians = angleDegrees * Math.PI / 180;
  const cosine = Math.cos(radians), sine = Math.sin(radians);
  const rotatedWidth = Math.abs(cosine) * physicalWidth + Math.abs(sine) * physicalHeight;
  const rotatedHeight = Math.abs(sine) * physicalWidth + Math.abs(cosine) * physicalHeight;
  const scale = Math.min((width - 2 * padding) / rotatedWidth, (height - 2 * padding) / rotatedHeight);
  const imageWidth = physicalWidth * scale, imageHeight = physicalHeight * scale;
  return {
    radians, imageWidth, imageHeight,
    toCanvas(u, v) {
      const x = (u - 0.5) * imageWidth, y = (v - 0.5) * imageHeight;
      return [width / 2 + cosine * x - sine * y, height / 2 + sine * x + cosine * y];
    },
    fromCanvas(x, y) {
      const dx = x - width / 2, dy = y - height / 2;
      return [0.5 + (cosine * dx + sine * dy) / imageWidth, 0.5 + (-sine * dx + cosine * dy) / imageHeight];
    }
  };
}

/** Linked RAS planes sampled directly from the native scalar data and affine. */
export class LinkedVolumeViews {
  constructor(root, manifest) {
    if (!(root instanceof HTMLElement)) throw new Error('MRI workspace is missing.');
    this.root = root;
    this.series = Array.isArray(manifest?.series) ? manifest.series : [];
    this.volume = null;
    this.current = null;
    this.cursor = [0, 0, 0];
    this.active = 'axial';
    this.cache = new Map();
    this.loadToken = 0;
    this.frame = 0;
    this.cine = null;
    this.brightness = 0;
    this.contrast = 1;
    this.palette = 'gray';
    this.crosshairs = true;
    this.axialAngle = 0;
    // A conservative display-only correction, checked against central T1 slices.
    // Other acquisitions keep their native orientation unless the visitor adjusts them.
    this.seriesAngles = new Map([['t1-axial', 6]]);
    this.disposed = false;
    this.events = new AbortController();
    this.planes = [
      { id: 'axial', name: 'Axial', axis: 2, u: 0, v: 1, top: 'A', bottom: 'P', left: 'R', right: 'L', help: 'Horizontal slices, from the lower to the upper head.' },
      { id: 'coronal', name: 'Coronal', axis: 1, u: 0, v: 2, top: 'S', bottom: 'I', left: 'R', right: 'L', help: 'Front-facing slices, from the back toward the face.' },
      { id: 'sagittal', name: 'Sagittal', axis: 0, u: 1, v: 2, top: 'S', bottom: 'I', left: 'A', right: 'P', help: 'Side-facing slices, from the left toward the right.' }
    ];
    this.build();
    const defaultId = manifest?.defaultSeries;
    const initial = this.series.find(s => s.id === defaultId) || this.series[0];
    if (initial) {
      this.select.value = initial.id;
      this.load(initial.id);
    } else {
      this.setStatus('No MRI series are available in this exhibit.', true);
    }
    this.resizeObserver = new ResizeObserver(() => this.scheduleRender());
    this.resizeObserver.observe(root);
    this.on(document, 'visibilitychange', () => { if (document.hidden) this.stopCine(); });
  }

  on(el, event, handler, options = {}) {
    el.addEventListener(event, handler, { ...options, signal: this.events.signal });
  }

  el(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  }

  build() {
    this.root.replaceChildren();
    this.root.classList.add('slice-studio');
    const detailChoice = this.el('section', 'slice-detail-choice panel');
    const detailCopy = this.el('div');
    detailCopy.append(this.el('h2', '', 'Choose the sharpest direction'), this.el('p', 'muted', 'Each scan captures one direction in finer detail. All three views stay linked to whichever scan you choose.'));
    const detailActions = this.el('div', 'slice-detail-actions');
    detailActions.setAttribute('role', 'group'); detailActions.setAttribute('aria-label', 'Preferred detail direction');
    this.detailButtons = new Map();
    for (const [id, label] of [['t1-axial', 'Axial · T1'], ['flair-coronal', 'Coronal · FLAIR'], ['t1-sagittal', 'Sagittal · T1']]) {
      if (!this.series.some(s => s.id === id)) continue;
      const button = this.el('button', 'button', label); button.type = 'button'; button.setAttribute('aria-pressed', 'false');
      this.on(button, 'click', () => { this.select.value = id; this.setActive(id.split('-')[1]); this.load(id); });
      detailActions.append(button); this.detailButtons.set(id, button);
    }
    detailChoice.append(detailCopy, detailActions);
    const toolbar = this.el('div', 'slice-toolbar panel');
    const sequenceLabel = this.el('label', 'control slice-sequence', 'MRI sequence');
    this.select = this.el('select');
    this.select.style.display = 'block'; this.select.style.marginTop = '8px';
    this.select.setAttribute('aria-label', 'MRI sequence');
    for (const s of this.series) {
      const option = this.el('option', '', String(s.label || s.sequence || s.id));
      option.value = String(s.id);
      this.select.append(option);
    }
    sequenceLabel.append(this.select);
    toolbar.append(sequenceLabel);
    this.on(this.select, 'change', () => this.load(this.select.value));

    const makeRange = (name, min, max, value, change) => {
      const label = this.el('label', 'control slice-adjustment');
      const caption = this.el('span', '', name);
      const output = this.el('output', 'slice-control-value');
      output.style.float = 'right'; output.style.marginLeft = '12px';
      const input = this.el('input');
      input.type = 'range'; input.min = min; input.max = max; input.value = value;
      input.style.display = 'block'; input.style.marginTop = '8px';
      input.setAttribute('aria-label', name);
      const update = () => { output.textContent = `${input.value}${name === 'Contrast' ? '%' : ''}`; change(Number(input.value)); this.scheduleRender(); };
      this.on(input, 'input', update);
      output.textContent = `${value}${name === 'Contrast' ? '%' : ''}`;
      caption.append(output); label.append(caption, input); toolbar.append(label);
      return { input, output };
    };
    this.brightnessControl = makeRange('Brightness', -100, 100, 0, n => { this.brightness = n; });
    this.contrastControl = makeRange('Contrast', 25, 300, 100, n => { this.contrast = n / 100; });
    this.angleControl = makeRange('Axial tilt', -20, 20, 0, n => this.setAxialAngle(n));
    this.angleControl.input.step = 0.5;
    this.angleControl.input.disabled = true;
    this.angleControl.input.title = 'Rotate only the axial display. Positive angles turn clockwise.';
    this.angleControl.output.textContent = '0°';
    const angleActions = this.el('div', 'slice-tilt-actions');
    this.nativeAngleButton = this.el('button', 'small-button', 'Native angle');
    this.nativeAngleButton.type = 'button'; this.nativeAngleButton.disabled = true;
    this.on(this.nativeAngleButton, 'click', () => this.setAxialAngle(0));
    this.straightenButton = this.el('button', 'small-button', 'Straighten +6°');
    this.straightenButton.type = 'button'; this.straightenButton.hidden = true;
    this.straightenButton.title = 'Approximate display alignment for the central T1 axial slices';
    this.on(this.straightenButton, 'click', () => this.setAxialAngle(6));
    angleActions.append(this.nativeAngleButton, this.straightenButton);
    const angleLabel = this.angleControl.input.parentElement;
    const angleGroup = this.el('div', 'control slice-tilt-control');
    angleLabel.classList.remove('control'); angleLabel.replaceWith(angleGroup); angleGroup.append(angleLabel, angleActions);

    const actions = this.el('div', 'slice-actions');
    this.cineButton = this.el('button', 'button', 'Play slices');
    this.cineButton.type = 'button'; this.cineButton.disabled = true;
    this.cineButton.setAttribute('aria-pressed', 'false');
    this.on(this.cineButton, 'click', () => this.cine ? this.stopCine() : this.startCine());
    this.crosshairButton = this.el('button', 'button', 'Crosshairs on');
    this.crosshairButton.type = 'button'; this.crosshairButton.setAttribute('aria-pressed', 'true');
    this.on(this.crosshairButton, 'click', () => {
      this.crosshairs = !this.crosshairs;
      this.crosshairButton.textContent = this.crosshairs ? 'Crosshairs on' : 'Crosshairs off';
      this.crosshairButton.setAttribute('aria-pressed', String(this.crosshairs)); this.scheduleRender();
    });
    this.paletteButton = this.el('button', 'button', 'Amber color');
    this.paletteButton.type = 'button'; this.paletteButton.setAttribute('aria-pressed', 'false');
    this.on(this.paletteButton, 'click', () => {
      this.palette = this.palette === 'gray' ? 'amber' : 'gray';
      this.paletteButton.setAttribute('aria-pressed', String(this.palette === 'amber'));
      this.paletteButton.textContent = this.palette === 'amber' ? 'Grayscale' : 'Amber color'; this.scheduleRender();
    });
    const reset = this.el('button', 'button', 'Reset views'); reset.type = 'button';
    this.on(reset, 'click', () => this.reset());
    this.snapshotButton = this.el('button', 'button', 'Save snapshot'); this.snapshotButton.type = 'button'; this.snapshotButton.disabled = true;
    this.on(this.snapshotButton, 'click', () => this.snapshot());
    actions.append(this.cineButton, this.crosshairButton, this.paletteButton, reset, this.snapshotButton);
    toolbar.append(actions);
    this.status = this.el('p', 'slice-status muted'); this.status.setAttribute('role', 'status'); this.status.setAttribute('aria-live', 'polite');
    this.retry = this.el('button', 'button', 'Retry loading'); this.retry.type = 'button'; this.retry.hidden = true;
    this.on(this.retry, 'click', () => this.load(this.select.value));
    this.metadata = this.el('p', 'slice-series-info muted');
    this.grid = this.el('div', 'slice-grid');
    for (const plane of this.planes) {
      const panel = this.el('section', 'slice-panel panel');
      panel.dataset.plane = plane.id;
      const header = this.el('div', 'slice-heading');
      const button = this.el('button', 'slice-plane-button', plane.name); button.type = 'button';
      button.setAttribute('aria-label', `Select ${plane.name.toLowerCase()} for slice playback`);
      button.setAttribute('aria-pressed', String(plane.id === this.active));
      this.on(button, 'click', () => this.setActive(plane.id));
      const output = this.el('output', 'plane-tag', '—'); header.append(button, output);
      const wrap = this.el('div', 'slice-canvas-wrap');
      const canvas = this.el('canvas', 'slice-canvas');
      canvas.width = 400; canvas.height = 400; canvas.tabIndex = 0;
      canvas.setAttribute('role', 'img'); canvas.setAttribute('aria-label', `${plane.name} MRI view. Click to position the linked crosshairs. Arrow keys change the slice.`);
      canvas.style.width = '100%'; canvas.style.height = '100%'; canvas.style.display = 'block'; canvas.style.touchAction = 'pan-y';
      wrap.append(canvas);
      const rangeLabel = this.el('label', 'control slice-controls');
      rangeLabel.style.display = 'block';
      const rangeCaption = this.el('span', 'slice-range-caption', `${plane.name} slice`);
      const slider = this.el('input'); slider.type = 'range'; slider.min = 0; slider.max = 0; slider.value = 0; slider.step = 1; slider.disabled = true;
      slider.setAttribute('aria-label', `${plane.name} slice`);
      rangeLabel.append(rangeCaption, slider);
      const hint = this.el('p', 'slice-notes muted', plane.help);
      hint.style.padding = '0 18px';
      panel.append(header, wrap, rangeLabel, hint); this.grid.append(panel);
      Object.assign(plane, { panel, button, canvas, wrap, slider, output, source: document.createElement('canvas') });
      this.on(slider, 'input', () => { this.setActive(plane.id); this.cursor[plane.axis] = Number(slider.value); this.scheduleRender(); });
      this.on(canvas, 'click', event => this.pick(plane, event));
      this.on(canvas, 'wheel', event => {
        if (!this.volume || !event.deltaY) return;
        event.preventDefault(); this.setActive(plane.id); this.step(plane, event.deltaY > 0 ? 1 : -1);
      }, { passive: false });
      this.on(canvas, 'keydown', event => {
        if (!this.volume) return;
        const delta = { ArrowUp: 1, ArrowRight: 1, ArrowDown: -1, ArrowLeft: -1, PageUp: 5, PageDown: -5 }[event.key];
        if (delta) { event.preventDefault(); this.setActive(plane.id); this.step(plane, delta); }
      });
    }
    const instructions = this.el('p', 'slice-notes muted', 'Click an image to move the linked crosshairs. Scroll over a view or use its slider to browse. R and L refer to the person’s right and left; A = front, P = back, S = top, I = bottom.');
    const tiltNote = this.el('p', 'slice-notes muted', 'T1 axial starts with an approximate +6° display tilt. Adjust Axial tilt to taste, or choose Native angle for 0°. Direction markers and crosshairs follow the image. This does not register the anatomy or change the data or the other two cutting planes.');
    const caveat = this.el('p', 'slice-notes muted', 'Views sample public 8-bit display image values on the original spatial grid, with linear interpolation. Intensity precision is reduced; spatial sampling is unchanged. The fine navigation steps do not represent new acquired slices. Source slices are 5 mm thick, spaced about 6.5 mm apart; the other directions remain softer. Changing scans preserves the nearest scanner position, without correcting for movement or differences in contrast. These views are not for diagnosis.');
    const resolutionHelp = this.el('details', 'slice-resolution-help');
    resolutionHelp.append(this.el('summary', '', 'What would make all three directions sharper?'), this.el('p', '', 'A whole-brain 3D T1 acquisition with roughly 1 mm isotropic sampling and no slice gaps would provide much more balanced detail. This export contains only 2D acquisitions. Converting DICOM to NIfTI changes the container, not the measured resolution. If a 3D series was acquired during this examination, its complete original export would be useful here.'));
    const sourceLink = this.el('a', '', 'About 3D T1 acquisition protocols ↗');
    sourceLink.href = 'https://adni.loni.usc.edu/help-faqs/faqs/'; sourceLink.target = '_blank'; sourceLink.rel = 'noopener noreferrer'; resolutionHelp.append(sourceLink);
    this.root.append(detailChoice, toolbar, this.status, this.retry, this.metadata, this.grid, instructions, tiltNote, caveat, resolutionHelp);
    this.setActive(this.active); this.scheduleRender();
  }

  setStatus(message, error = false) {
    this.status.textContent = message;
    this.status.classList.toggle('is-error', error);
    this.retry.hidden = !error || this.series.length === 0;
  }

  async load(id) {
    const series = this.series.find(s => String(s.id) === String(id));
    if (!series) return;
    if (this.current && Array.isArray(this.current.origin) && this.current.origin.length === 3) {
      this.lastWorld = this.cursor.map((n, axis) => this.current.origin[axis] + n * this.current.spacing[axis]);
    }
    const worldPoint = this.lastWorld;
    this.stopCine(); this.fetchController?.abort();
    const token = ++this.loadToken;
    this.fetchController = new AbortController();
    const signal = this.fetchController.signal;
    this.volume = null; this.current = null;
    for (const [buttonId, button] of this.detailButtons) button.setAttribute('aria-pressed', String(buttonId === String(id)));
    this.cineButton.disabled = true; this.snapshotButton.disabled = true;
    this.angleControl.input.disabled = true; this.nativeAngleButton.disabled = true;
    this.straightenButton.hidden = true;
    this.planes.forEach(p => { p.slider.disabled = true; p.output.textContent = '—'; });
    this.metadata.textContent = '';
    this.setStatus(`Loading ${series.label || series.sequence || 'MRI'}…`);
    this.root.setAttribute('aria-busy', 'true'); this.scheduleRender();
    try {
      if (!this.nativeSeries) {
        const metadataResponse = await fetch(sliceAssetUrl('linked-series.json'), { signal });
        if (!metadataResponse.ok) throw new Error('The source image details could not load. Please retry.');
        const metadata = await metadataResponse.json();
        if (token !== this.loadToken || this.disposed) return;
        if (!Array.isArray(metadata.series)) throw new Error('The source image details are invalid.');
        this.nativeSeries = metadata.series;
      }
      const source = this.nativeSeries.find(s => s.id === String(id));
      if (!source || typeof source.file !== 'string' || !/^[A-Za-z0-9_-][A-Za-z0-9_.-]*\.nii\.gz$/.test(source.file) || source.file.includes('..')) throw new Error('The MRI data path is invalid.');
      if (!['axial', 'coronal', 'sagittal'].includes(source.sourcePlane?.name)) throw new Error('The MRI acquisition direction is invalid.');
      let volume = this.cache.get(String(id));
      if (!volume) {
        if (typeof DecompressionStream === 'undefined') throw new Error('This viewer needs a browser with gzip decompression support. Try a current Safari, Chrome, Edge, or Firefox.');
        const response = await fetch(sliceAssetUrl(source.file), { signal });
        if (!response.ok || !response.body) throw new Error(`The MRI file could not be downloaded (${response.status}).`);
        const buffer = await new Response(response.body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
        if (token !== this.loadToken || this.disposed) return;
        volume = parseNativeNifti(buffer);
        if (!Array.isArray(source.dims) || volume.dims.some((n, axis) => n !== source.dims[axis])) throw new Error('The MRI dimensions do not match its source details.');
        volume.grid = createLinkedGrid(volume, 0.5);
      }
      if (token !== this.loadToken || this.disposed) return;
      this.cache.delete(String(id)); this.cache.set(String(id), volume);
      while (this.cache.size > 2) this.cache.delete(this.cache.keys().next().value);
      const windowIntensity = [source.defaultWindow?.low, source.defaultWindow?.high];
      if (!Array.isArray(windowIntensity) || windowIntensity.length !== 2 || !windowIntensity.every(Number.isFinite) || windowIntensity[1] <= windowIntensity[0]) throw new Error('The MRI intensity window is invalid.');
      this.volume = volume; this.current = { ...series, ...volume.grid, windowIntensity, sourcePlane: source.sourcePlane.name };
      const { dims, spacing, origin } = this.current;
      this.setAxialAngle(this.seriesAngles.get(String(id)) ?? 0);
      this.cursor = dims.map((n, axis) => worldPoint
        ? Math.max(0, Math.min(n - 1, Math.round((worldPoint[axis] - origin[axis]) / spacing[axis])))
        : Math.floor(n / 2));
      for (const p of this.planes) { p.slider.max = dims[p.axis] - 1; p.slider.disabled = false; }
      this.cineButton.disabled = false; this.snapshotButton.disabled = false;
      this.angleControl.input.disabled = false; this.nativeAngleButton.disabled = false;
      this.straightenButton.hidden = series.id !== 't1-axial';
      const nativeSpacing = Array.isArray(series.nativeSpacing) ? series.nativeSpacing : spacing;
      const format = numbers => numbers.map(n => Number(n).toFixed(2).replace(/\.?0+$/, '')).join(' × ');
      this.metadata.textContent = `${series.label || series.sequence || 'MRI'} · ${series.sourceSlices} acquired slices · Stored spacing ${format(nativeSpacing)} mm · Display image values · 0.5 mm navigation steps (interpolated)`;
      this.setStatus(`All three views are linked. This scan has its finest detail in the ${source.sourcePlane.name} direction.`);
      this.scheduleRender();
    } catch (error) {
      if (token === this.loadToken && !this.disposed && error.name !== 'AbortError') this.setStatus(error.message || 'The MRI could not be loaded. Please retry.', true);
    } finally {
      if (token === this.loadToken && !this.disposed) this.root.removeAttribute('aria-busy');
    }
  }

  setActive(id) {
    this.active = id;
    for (const p of this.planes) { p.panel.classList.toggle('active', p.id === id); p.button.setAttribute('aria-pressed', String(p.id === id)); }
    if (this.cine) this.cineButton.textContent = `Pause ${id}`;
  }

  step(plane, delta, wrap = false) {
    if (!this.volume) return;
    const size = this.current.dims[plane.axis];
    const next = this.cursor[plane.axis] + delta;
    this.cursor[plane.axis] = wrap ? (next + size) % size : Math.max(0, Math.min(size - 1, next));
    this.scheduleRender();
  }

  setAxialAngle(degrees) {
    this.axialAngle = Math.max(-20, Math.min(20, Number(degrees) || 0));
    if (this.current) this.seriesAngles.set(String(this.current.id), this.axialAngle);
    if (this.angleControl) {
      this.angleControl.input.value = this.axialAngle;
      this.angleControl.output.textContent = `${this.axialAngle > 0 ? '+' : ''}${this.axialAngle}°`;
      this.angleControl.input.setAttribute('aria-valuetext', this.axialAngle === 0 ? 'Native angle, zero degrees' : `${Math.abs(this.axialAngle)} degrees ${this.axialAngle > 0 ? 'clockwise' : 'counterclockwise'}, display only`);
    }
    this.scheduleRender();
  }

  pick(plane, event) {
    if (!this.volume) return;
    this.setActive(plane.id);
    const rect = plane.canvas.getBoundingClientRect();
    const dims = this.current.dims;
    const transform = plane.displayTransform;
    if (!transform || !rect.width || !rect.height) return;
    const [u, v] = transform.fromCanvas(
      (event.clientX - rect.left) / rect.width * plane.canvas.width,
      (event.clientY - rect.top) / rect.height * plane.canvas.height
    );
    // Letterbox margins do not represent voxels. Ignore them instead of snapping to an edge.
    if (u < 0 || u > 1 || v < 0 || v > 1) return;
    // All displays reverse their horizontal and vertical data axes in RAS.
    this.cursor[plane.u] = Math.max(0, Math.min(dims[plane.u] - 1, dims[plane.u] - 1 - Math.floor(u * dims[plane.u])));
    this.cursor[plane.v] = Math.max(0, Math.min(dims[plane.v] - 1, dims[plane.v] - 1 - Math.floor(v * dims[plane.v])));
    this.scheduleRender();
  }

  scheduleRender() {
    if (this.frame || this.disposed || this.suspended) return;
    this.frame = requestAnimationFrame(() => { this.frame = 0; this.render(); });
  }

  render() {
    for (const plane of this.planes) {
      const canvas = plane.canvas;
      const dims = this.current?.dims || [1, 1, 1];
      const spacing = this.current?.spacing || [1, 1, 1];
      const width = Math.min(1200, Math.max(240, Math.round((canvas.getBoundingClientRect().width || 400) * Math.min(window.devicePixelRatio || 1, 2))));
      const height = width;
      if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#070b12'; ctx.fillRect(0, 0, width, height);
      if (!this.volume) {
        ctx.fillStyle = '#738392'; ctx.font = `${Math.round(width / 25)}px system-ui`; ctx.textAlign = 'center'; ctx.fillText('MRI preview', width / 2, height / 2); continue;
      }
      // Sample only the displayed plane, without a spatially downsampled volume.
      // Windowing follows interpolation of the native-grid 8-bit display values.
      const rawWidth = Math.min(768, Math.max(dims[plane.u], width));
      const rawHeight = Math.min(768, Math.max(dims[plane.v], height));
      const renderKey = [this.current.id, this.cursor[plane.axis], rawWidth, rawHeight, this.brightness, this.contrast, this.palette].join(':');
      if (plane.renderKey !== renderKey) {
        if (plane.source.width !== rawWidth || plane.source.height !== rawHeight) { plane.source.width = rawWidth; plane.source.height = rawHeight; }
        const pixels = renderLinkedPlane(this.volume, this.current, this.cursor, plane, rawWidth, rawHeight, {
          window: this.current.windowIntensity, brightness: this.brightness, contrast: this.contrast, palette: this.palette
        });
        plane.source.getContext('2d').putImageData(new ImageData(pixels, rawWidth, rawHeight), 0, 0);
        plane.renderKey = renderKey;
      }
      const fontSize = Math.max(14, Math.round(width / 25));
      const angle = plane.id === 'axial' ? this.axialAngle : 0;
      const transform = getSliceDisplayTransform(width, height, dims[plane.u] * spacing[plane.u], dims[plane.v] * spacing[plane.v], angle, fontSize * 1.65);
      plane.displayTransform = transform;
      const { imageWidth, imageHeight, radians } = transform;
      ctx.save(); ctx.translate(width / 2, height / 2); ctx.rotate(radians);
      ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(plane.source, -imageWidth / 2, -imageHeight / 2, imageWidth, imageHeight);
      if (this.crosshairs) {
        const x = ((dims[plane.u] - this.cursor[plane.u] - 0.5) / dims[plane.u] - 0.5) * imageWidth;
        const y = ((dims[plane.v] - this.cursor[plane.v] - 0.5) / dims[plane.v] - 0.5) * imageHeight;
        ctx.strokeStyle = 'rgba(119,236,210,.72)'; ctx.lineWidth = Math.max(1, width / 500);
        ctx.beginPath(); ctx.moveTo(-imageWidth / 2, y); ctx.lineTo(imageWidth / 2, y); ctx.moveTo(x, -imageHeight / 2); ctx.lineTo(x, imageHeight / 2); ctx.stroke();
        ctx.beginPath(); ctx.arc(x, y, Math.max(3, width / 85), 0, Math.PI * 2); ctx.stroke();
      }
      ctx.restore();
      ctx.font = `600 ${fontSize}px system-ui`; ctx.textBaseline = 'middle';
      ctx.fillStyle = '#e3eee8'; ctx.shadowColor = '#000'; ctx.shadowBlur = 5;
      ctx.textAlign = 'center';
      const markers = [
        [plane.top, 0.5, -fontSize * 0.8 / imageHeight],
        [plane.bottom, 0.5, 1 + fontSize * 0.8 / imageHeight],
        [plane.left, -fontSize * 0.8 / imageWidth, 0.5],
        [plane.right, 1 + fontSize * 0.8 / imageWidth, 0.5]
      ];
      for (const [label, u, v] of markers) ctx.fillText(label, ...transform.toCanvas(u, v));
      ctx.shadowBlur = 0;
      const sliceIndex = this.cursor[plane.axis];
      plane.slider.value = sliceIndex;
      plane.output.textContent = `${sliceIndex + 1} / ${dims[plane.axis]}`;
      plane.slider.setAttribute('aria-valuetext', `${plane.name} interpolated position ${sliceIndex + 1} of ${dims[plane.axis]}`);
      const orientation = angle ? `Display rotated ${Math.abs(angle)} degrees ${angle > 0 ? 'clockwise' : 'counterclockwise'}; patient direction markers rotate with the image.` : `${plane.top} at top, ${plane.left} at left.`;
      canvas.setAttribute('aria-label', `${plane.name} MRI, interpolated position ${sliceIndex + 1} of ${dims[plane.axis]}. ${orientation} Click to position crosshairs; arrow keys change slice.`);
    }
  }

  startCine() {
    if (!this.volume || this.cine) return;
    this.cineButton.textContent = `Pause ${this.active}`; this.cineButton.setAttribute('aria-pressed', 'true');
    this.cine = setInterval(() => this.step(this.planes.find(p => p.id === this.active), 1, true), 140);
  }

  stopCine() {
    if (this.cine) clearInterval(this.cine);
    this.cine = null;
    if (this.cineButton) { this.cineButton.textContent = 'Play slices'; this.cineButton.setAttribute('aria-pressed', 'false'); }
  }

  pause() { this.stopCine(); }

  suspend() {
    this.pause(); this.suspended = true;
    this.loadToken++; this.fetchController?.abort();
    this.root.removeAttribute('aria-busy');
    if (this.frame) { cancelAnimationFrame(this.frame); this.frame = 0; }
  }

  resume() {
    this.suspended = false;
    if (!this.volume && this.select.value) this.load(this.select.value);
    else this.scheduleRender();
  }

  reset() {
    this.stopCine(); this.brightness = 0; this.contrast = 1;
    this.brightnessControl.input.value = 0; this.brightnessControl.output.textContent = '0';
    this.contrastControl.input.value = 100; this.contrastControl.output.textContent = '100%';
    this.setAxialAngle(0);
    if (this.current) this.cursor = this.current.dims.map(n => Math.floor(n / 2));
    this.scheduleRender();
  }

  snapshot() {
    if (!this.volume) return;
    this.render();
    const result = document.createElement('canvas'); result.width = 1500; result.height = 760;
    const ctx = result.getContext('2d'); ctx.fillStyle = '#070b12'; ctx.fillRect(0, 0, result.width, result.height);
    ctx.fillStyle = '#eef4ee'; ctx.font = '600 28px system-ui'; ctx.fillText('MRI / THREE VIEWS', 36, 48);
    ctx.fillStyle = '#9facb5'; ctx.font = '18px system-ui'; ctx.fillText(String(this.current.label || this.current.sequence || 'MRI'), 36, 80);
    this.planes.forEach((plane, index) => {
      const x = 36 + index * 488;
      const scale = Math.min(452 / plane.canvas.width, 548 / plane.canvas.height);
      const width = plane.canvas.width * scale, height = plane.canvas.height * scale;
      ctx.drawImage(plane.canvas, x + (452 - width) / 2, 125 + (548 - height) / 2, width, height);
      ctx.fillStyle = '#eef4ee'; ctx.font = '20px system-ui'; ctx.fillText(`${plane.name}  ·  ${plane.output.textContent}`, x, 116);
    });
    ctx.fillStyle = '#9facb5'; ctx.font = '16px system-ui'; ctx.fillText(`Display MRI reformat · Axial display tilt ${this.axialAngle > 0 ? '+' : ''}${this.axialAngle}° · Not for diagnosis`, 36, 724);
    result.toBlob(blob => {
      if (!blob || this.disposed) return;
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a'); link.href = url; link.download = 'mri-three-views.png'; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }, 'image/png');
  }

  destroy() {
    this.disposed = true; this.stopCine(); this.loadToken++; this.fetchController?.abort();
    this.events.abort(); this.resizeObserver?.disconnect(); if (this.frame) cancelAnimationFrame(this.frame);
    this.cache.clear(); this.volume = null; this.root.replaceChildren();
  }
}

/** Choose original acquired slices or linked reformats without mixing their geometry. */
export class SliceStudio {
  constructor(root, manifest) {
    if (!(root instanceof HTMLElement)) throw new Error('MRI workspace is missing.');
    this.root = root; this.manifest = manifest; this.mode = null; this.token = 0;
    this.events = new AbortController(); this.disposed = false;
    root.replaceChildren();
    const modes = document.createElement('div'); modes.className = 'slice-mode-switch';
    modes.setAttribute('role', 'group'); modes.setAttribute('aria-label', 'MRI viewing mode');
    this.buttons = {};
    this.roots = {};
    for (const [id, label] of [['native', 'Original slices'], ['linked', 'Linked volume']]) {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'button';
      button.textContent = label; button.setAttribute('aria-pressed', 'false');
      button.addEventListener('click', () => this.setMode(id), { signal: this.events.signal });
      modes.append(button); this.buttons[id] = button;
      const content = document.createElement('div'); content.className = `slice-mode-content slice-mode-${id}`;
      content.hidden = true; this.roots[id] = content;
    }
    this.note = document.createElement('p'); this.note.className = 'slice-mode-note muted';
    root.append(modes, this.note, this.roots.native, this.roots.linked);
    this.setMode('native');
  }

  async setMode(mode) {
    if (this.disposed || !this.roots[mode] || (this.mode === mode && this[mode])) return;
    const token = ++this.token;
    this[this.mode]?.suspend?.(); this.mode = mode;
    for (const id of Object.keys(this.roots)) {
      this.roots[id].hidden = id !== mode;
      this.buttons[id].setAttribute('aria-pressed', String(id === mode));
    }
    this.note.textContent = mode === 'native'
      ? 'Each view uses its own acquisition; contrast and slice positions differ.'
      : 'Three connected views from public display data on the original spatial grid. Choose a scan below to prioritize detail in its acquired direction.';
    if (this[mode]) { this[mode].resume(); return; }
    if (mode === 'linked') {
      this.linked = new LinkedVolumeViews(this.roots.linked, this.manifest);
      return;
    }
    const loading = document.createElement('p'); loading.className = 'slice-status muted'; loading.setAttribute('role', 'status');
    loading.textContent = 'Loading original MRI slices…'; this.roots.native.replaceChildren(loading);
    try {
      const moduleUrl = new URL('./native-slices.js', import.meta.url);
      moduleUrl.searchParams.set('v', ASSET_VERSION);
      const { NativeViews } = await import(moduleUrl.href);
      if (token !== this.token || this.disposed || this.mode !== 'native') return;
      this.native = new NativeViews(this.roots.native, {
        assetUrl: sliceAssetUrl, displayTransform: getSliceDisplayTransform,
        showLinked: () => { this.setMode('linked'); this.buttons.linked.focus(); }
      });
    } catch {
      if (token !== this.token || this.disposed) return;
      loading.textContent = 'Original slices could not be opened. Retry or use Linked volume.';
      const retry = document.createElement('button'); retry.className = 'button'; retry.type = 'button'; retry.textContent = 'Retry original slices';
      retry.addEventListener('click', () => this.setMode('native'), { signal: this.events.signal });
      this.roots.native.append(retry);
    }
  }

  pause() { this.native?.pause(); this.linked?.pause(); }
  destroy() {
    this.disposed = true; this.token++; this.events.abort();
    this.native?.destroy(); this.linked?.destroy(); this.root.replaceChildren();
  }
}
