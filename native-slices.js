const PLANE_NAMES = { axial: 'Axial', coronal: 'Coronal', sagittal: 'Sagittal' };

/** Check only the geometry used by the viewer; labels are always assigned as text. */
export function validateNativeDescriptor(descriptor) {
  if (descriptor?.version !== 1 || descriptor.format !== 'uint8-gzip' || descriptor.byteOrder !== 'x-fastest' || descriptor.spatialResampling !== false || !Array.isArray(descriptor.series) || descriptor.series.length !== 3) {
    throw new Error('The original-slice index has an unsupported format.');
  }
  const ids = new Set();
  for (const series of descriptor.series) {
    const { dims, spacing, plane } = series;
    if (!plane || !Object.hasOwn(PLANE_NAMES, plane.id) || ids.has(plane.id)) throw new Error('The original-slice directions are invalid.');
    ids.add(plane.id);
    if (!Array.isArray(dims) || dims.length !== 3 || dims.some(n => !Number.isInteger(n) || n < 2 || n > 1024) || dims.reduce((a, b) => a * b, 1) > 134217728) throw new Error('The original-slice dimensions are invalid.');
    if (!Array.isArray(spacing) || spacing.length !== 3 || spacing.some(n => !Number.isFinite(n) || n <= 0)) throw new Error('The original-slice spacing is invalid.');
    if ([plane.axis, plane.u, plane.v].some(n => !Number.isInteger(n) || n < 0 || n > 2) || new Set([plane.axis, plane.u, plane.v]).size !== 3) throw new Error('The original-slice axes are invalid.');
    if (typeof plane.flipU !== 'boolean' || typeof plane.flipV !== 'boolean' || ['top', 'bottom', 'left', 'right'].some(key => !['A', 'P', 'R', 'L', 'S', 'I'].includes(plane[key]))) throw new Error('The original-slice orientation labels are invalid.');
    if (!Number.isInteger(series.defaultIndex) || series.defaultIndex < 0 || series.defaultIndex >= dims[plane.axis]) throw new Error('The original-slice starting position is invalid.');
    if (series.sourceSlices !== dims[plane.axis] || !Number.isFinite(series.sliceThickness) || series.sliceThickness <= 0) throw new Error('The original-slice acquisition details are invalid.');
    if (typeof series.file !== 'string' || !/^[A-Za-z0-9_-][A-Za-z0-9_.-]*\.raw\.gz$/.test(series.file) || series.file.includes('..')) throw new Error('The original-slice data path is invalid.');
  }
  return descriptor;
}

/** Extract acquired pixels by axis permutation/flips only, never interpolation. */
export function nativeSlicePixels(volume, series, index, output) {
  const { dims, plane } = series;
  const width = dims[plane.u], height = dims[plane.v];
  if (!Number.isInteger(index) || index < 0 || index >= dims[plane.axis]) throw new RangeError('Slice index is outside the acquired stack.');
  if (volume.length !== dims[0] * dims[1] * dims[2]) throw new RangeError('The acquired stack has an unexpected size.');
  const pixels = output || new Uint8Array(width * height);
  if (pixels.length !== width * height) throw new RangeError('The slice buffer has an unexpected size.');
  const stride = [1, dims[0], dims[0] * dims[1]];
  const fixed = index * stride[plane.axis];
  for (let v = 0; v < height; v++) {
    const row = fixed + (plane.flipV ? height - 1 - v : v) * stride[plane.v];
    for (let u = 0; u < width; u++) pixels[v * width + u] = volume[row + (plane.flipU ? width - 1 - u : u) * stride[plane.u]];
  }
  return pixels;
}

/** Independent, original acquired MRI stacks, retaining their original obliquity. */
export class NativeViews {
  constructor(root, { assetUrl, displayTransform, showLinked }) {
    this.root = root; this.assetUrl = assetUrl; this.displayTransform = displayTransform; this.showLinked = showLinked;
    this.events = new AbortController(); this.loadToken = 0; this.frame = 0; this.cine = null;
    this.active = 'axial'; this.brightness = 0; this.contrast = 1; this.palette = 'gray';
    this.suspended = false; this.disposed = false;
    this.planes = Object.entries(PLANE_NAMES).map(([id, name]) => ({ id, name, index: 0, volume: null, series: null }));
    this.build();
    this.resizeObserver = new ResizeObserver(() => this.scheduleRender()); this.resizeObserver.observe(root);
    this.on(document, 'visibilitychange', () => { if (document.hidden) this.pause(); });
    this.load();
  }

  el(tag, className, text) {
    const element = document.createElement(tag); if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  }
  on(element, type, handler, options = {}) { element.addEventListener(type, handler, { ...options, signal: this.events.signal }); }

  build() {
    this.root.replaceChildren(); this.root.classList.add('slice-studio');
    const toolbar = this.el('div', 'slice-toolbar panel');
    const makeRange = (name, min, max, value, change) => {
      const label = this.el('label', 'control slice-adjustment'); const caption = this.el('span', '', name);
      const output = this.el('output', 'slice-control-value', `${value}${name === 'Contrast' ? '%' : ''}`);
      output.style.float = 'right'; output.style.marginLeft = '12px';
      const input = this.el('input'); input.type = 'range'; input.min = min; input.max = max; input.value = value;
      input.setAttribute('aria-label', `Original slices ${name.toLowerCase()}`); input.style.display = 'block'; input.style.marginTop = '8px';
      this.on(input, 'input', () => { output.textContent = `${input.value}${name === 'Contrast' ? '%' : ''}`; change(Number(input.value)); this.scheduleRender(); });
      caption.append(output); label.append(caption, input); toolbar.append(label); return { input, output };
    };
    this.brightnessControl = makeRange('Brightness', -100, 100, 0, value => { this.brightness = value; });
    this.contrastControl = makeRange('Contrast', 25, 300, 100, value => { this.contrast = value / 100; });
    const actions = this.el('div', 'slice-actions');
    this.cineButton = this.el('button', 'button', 'Play slices'); this.cineButton.type = 'button'; this.cineButton.disabled = true; this.cineButton.setAttribute('aria-pressed', 'false');
    this.on(this.cineButton, 'click', () => this.cine ? this.pause() : this.startCine());
    this.paletteButton = this.el('button', 'button', 'Amber color'); this.paletteButton.type = 'button'; this.paletteButton.setAttribute('aria-pressed', 'false');
    this.on(this.paletteButton, 'click', () => {
      this.palette = this.palette === 'gray' ? 'amber' : 'gray'; this.paletteButton.textContent = this.palette === 'amber' ? 'Grayscale' : 'Amber color';
      this.paletteButton.setAttribute('aria-pressed', String(this.palette === 'amber')); this.scheduleRender();
    });
    const reset = this.el('button', 'button', 'Reset views'); reset.type = 'button'; this.on(reset, 'click', () => this.reset());
    this.snapshotButton = this.el('button', 'button', 'Save snapshot'); this.snapshotButton.type = 'button'; this.snapshotButton.disabled = true;
    this.on(this.snapshotButton, 'click', () => this.snapshot());
    actions.append(this.cineButton, this.paletteButton, reset, this.snapshotButton); toolbar.append(actions);
    this.status = this.el('p', 'slice-status muted'); this.status.setAttribute('role', 'status'); this.status.setAttribute('aria-live', 'polite');
    this.recovery = this.el('div', 'slice-actions'); this.recovery.hidden = true;
    const retry = this.el('button', 'button', 'Retry original slices'); retry.type = 'button'; this.on(retry, 'click', () => this.load());
    const fallback = this.el('button', 'button', 'Use Linked volume'); fallback.type = 'button'; this.on(fallback, 'click', this.showLinked);
    this.recovery.append(retry, fallback);
    this.grid = this.el('div', 'slice-grid');
    for (const plane of this.planes) {
      const panel = this.el('section', 'slice-panel panel'); panel.dataset.plane = plane.id;
      const heading = this.el('div', 'slice-heading');
      const headingGroup = this.el('div');
      const button = this.el('button', 'slice-plane-button', plane.name); button.type = 'button';
      button.setAttribute('aria-label', `Select original ${plane.id} slices for playback`); this.on(button, 'click', () => this.setActive(plane.id));
      const acquisition = this.el('div', 'slice-acquisition-label muted', 'Original acquisition'); headingGroup.append(button, acquisition);
      const output = this.el('output', 'plane-tag', '—'); heading.append(headingGroup, output);
      const wrap = this.el('div', 'slice-canvas-wrap'); const canvas = this.el('canvas', 'slice-canvas');
      canvas.width = 512; canvas.height = 512; canvas.tabIndex = 0; canvas.setAttribute('role', 'img');
      canvas.style.width = '100%'; canvas.style.height = '100%'; canvas.style.display = 'block'; canvas.style.touchAction = 'pan-y';
      canvas.setAttribute('aria-label', `${plane.name} original MRI slices. Arrow keys browse this acquisition.`); wrap.append(canvas);
      const label = this.el('label', 'control slice-controls'); label.style.display = 'block';
      const caption = this.el('span', 'slice-range-caption', `${plane.name} slice`);
      const slider = this.el('input'); slider.type = 'range'; slider.min = 0; slider.max = 0; slider.value = 0; slider.step = 1; slider.disabled = true;
      slider.setAttribute('aria-label', `Original ${plane.id} slice`); label.append(caption, slider);
      const info = this.el('p', 'slice-notes muted', 'Loading acquired pixels…'); info.style.padding = '0 18px';
      panel.append(heading, wrap, label, info); this.grid.append(panel);
      Object.assign(plane, { panel, button, acquisition, output, canvas, slider, info, source: document.createElement('canvas') });
      this.on(slider, 'input', () => { this.setActive(plane.id); plane.index = Number(slider.value); this.scheduleRender(); });
      this.on(canvas, 'click', () => this.setActive(plane.id));
      this.on(canvas, 'wheel', event => {
        if (!plane.volume || !event.deltaY) return;
        event.preventDefault(); this.setActive(plane.id); this.step(plane, event.deltaY > 0 ? 1 : -1);
      }, { passive: false });
      this.on(canvas, 'keydown', event => {
        const delta = { ArrowUp: 1, ArrowRight: 1, ArrowDown: -1, ArrowLeft: -1, PageUp: 5, PageDown: -5 }[event.key];
        if (delta && plane.volume) { event.preventDefault(); this.setActive(plane.id); this.step(plane, delta); }
      });
    }
    const instructions = this.el('p', 'slice-notes muted', 'Scroll over a view or use its slider to browse that scan. Select a view for playback. The three slice positions are independent.');
    const orientation = this.el('p', 'slice-notes muted', 'These images keep their original acquisition angle. Direction letters show the nearest anatomical direction: R = right, L = left, A = front, P = back, S = top, I = bottom.');
    const caveat = this.el('p', 'slice-notes muted', 'Original 512 × 512 pixel grids, displayed with an 8-bit brightness window. Pixels are about 0.47 mm apart within each image; slices remain 5 mm thick and about 6.5 mm apart. Screen fitting does not add measured detail. Educational viewing only.');
    this.root.append(toolbar, this.status, this.recovery, this.grid, instructions, orientation, caveat);
    this.setActive(this.active); this.scheduleRender();
  }

  async load() {
    this.pause(); this.fetchController?.abort(); const token = ++this.loadToken;
    this.fetchController = new AbortController(); const signal = this.fetchController.signal;
    this.status.textContent = 'Loading original MRI slices…'; this.status.classList.remove('is-error'); this.recovery.hidden = true;
    this.root.setAttribute('aria-busy', 'true');
    try {
      if (!this.descriptor) {
        const response = await fetch(this.assetUrl('native-series.json'), { signal });
        if (!response.ok) throw new Error(`The original-slice index could not be downloaded (${response.status}).`);
        const descriptor = validateNativeDescriptor(await response.json());
        if (!this.isCurrent(token)) return;
        this.descriptor = descriptor;
        for (const plane of this.planes) {
          plane.series = descriptor.series.find(series => series.plane.id === plane.id);
          plane.index = plane.series.defaultIndex;
          const { dims, spacing, sliceThickness, plane: axes } = plane.series;
          plane.slider.max = dims[axes.axis] - 1;
          plane.acquisition.textContent = plane.series.label;
          plane.info.textContent = `${dims[axes.u]} × ${dims[axes.v]} pixels · ${spacing[axes.u].toFixed(2)} × ${spacing[axes.v].toFixed(2)} mm · ${sliceThickness} mm thick`;
        }
      }
      await Promise.all(this.planes.map(async plane => {
        if (plane.volume) return;
        plane.error = null;
        try {
          if (typeof DecompressionStream === 'undefined') throw new Error('This browser does not support gzip decompression.');
          const response = await fetch(this.assetUrl(plane.series.file), { signal });
          if (!response.ok || !response.body) throw new Error(`Download failed (${response.status}).`);
          const buffer = await new Response(response.body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
          if (!this.isCurrent(token)) return;
          const volume = new Uint8Array(buffer);
          if (volume.length !== plane.series.dims.reduce((a, b) => a * b, 1)) throw new Error('The downloaded scan has an unexpected size.');
          plane.volume = volume; plane.slider.disabled = false; this.updateActions(); this.scheduleRender();
        } catch (error) {
          if (this.isCurrent(token) && error.name !== 'AbortError') { plane.error = error.message; this.scheduleRender(); }
        }
      }));
      if (!this.isCurrent(token)) return;
      const loaded = this.planes.filter(plane => plane.volume).length;
      this.status.textContent = loaded === 3 ? 'Original acquired slices · T1 axial, FLAIR coronal, and T1 sagittal.' : `${loaded} of 3 acquisitions loaded. Retry the missing views, or use Linked volume.`;
      this.recovery.hidden = loaded === 3; this.status.classList.toggle('is-error', loaded !== 3);
      this.updateActions();
    } catch (error) {
      if (this.isCurrent(token) && error.name !== 'AbortError') {
        this.status.textContent = error.message || 'Original slices could not be loaded.';
        this.status.classList.add('is-error'); this.recovery.hidden = false;
      }
    } finally {
      if (this.isCurrent(token)) { this.root.removeAttribute('aria-busy'); this.scheduleRender(); }
    }
  }

  isCurrent(token) { return token === this.loadToken && !this.disposed && !this.suspended; }
  updateActions() {
    this.cineButton.disabled = !this.planes.find(plane => plane.id === this.active)?.volume;
    this.snapshotButton.disabled = !this.planes.every(plane => plane.volume);
  }
  setActive(id) {
    this.active = id;
    for (const plane of this.planes) { plane.panel.classList.toggle('active', plane.id === id); plane.button.setAttribute('aria-pressed', String(plane.id === id)); }
    if (this.cine) {
      if (!this.planes.find(plane => plane.id === id)?.volume) this.pause();
      else this.cineButton.textContent = `Pause ${id}`;
    }
    this.updateActions();
  }
  step(plane, delta, wrap = false) {
    if (!plane?.volume) return;
    const count = plane.series.dims[plane.series.plane.axis], next = plane.index + delta;
    plane.index = wrap ? (next % count + count) % count : Math.max(0, Math.min(count - 1, next)); this.scheduleRender();
  }
  scheduleRender() {
    if (this.frame || this.disposed || this.suspended) return;
    this.frame = requestAnimationFrame(() => { this.frame = 0; this.render(); });
  }
  render() {
    const lut = new Uint8ClampedArray(256 * 3);
    for (let value = 0; value < 256; value++) {
      const intensity = Math.max(0, Math.min(255, (value - 127.5) * this.contrast + 127.5 + this.brightness));
      lut[value * 3] = intensity; lut[value * 3 + 1] = intensity * (this.palette === 'amber' ? .75 : 1); lut[value * 3 + 2] = intensity * (this.palette === 'amber' ? .36 : 1);
    }
    for (const plane of this.planes) {
      const canvas = plane.canvas;
      const size = Math.min(1200, Math.max(240, Math.round((canvas.getBoundingClientRect().width || 400) * Math.min(window.devicePixelRatio || 1, 2))));
      if (canvas.width !== size || canvas.height !== size) { canvas.width = size; canvas.height = size; }
      const context = canvas.getContext('2d'); context.fillStyle = '#070b12'; context.fillRect(0, 0, size, size);
      if (!plane.volume) {
        context.fillStyle = '#a1b1c8'; context.font = `${Math.round(size / 25)}px system-ui`; context.textAlign = 'center';
        context.fillText(plane.error ? 'Acquisition unavailable · Retry below' : 'Loading original slices…', size / 2, size / 2); continue;
      }
      const { dims, spacing, plane: axes } = plane.series;
      const width = dims[axes.u], height = dims[axes.v];
      if (plane.source.width !== width || plane.source.height !== height) { plane.source.width = width; plane.source.height = height; }
      if (!plane.pixels || plane.pixels.length !== width * height) plane.pixels = new Uint8Array(width * height);
      nativeSlicePixels(plane.volume, plane.series, plane.index, plane.pixels);
      const sourceContext = plane.source.getContext('2d'); const image = sourceContext.createImageData(width, height);
      for (let index = 0; index < plane.pixels.length; index++) {
        const value = plane.pixels[index], offset = index * 4;
        image.data[offset] = lut[value * 3]; image.data[offset + 1] = lut[value * 3 + 1]; image.data[offset + 2] = lut[value * 3 + 2]; image.data[offset + 3] = 255;
      }
      sourceContext.putImageData(image, 0, 0);
      const fontSize = Math.max(14, Math.round(size / 25));
      const transform = this.displayTransform(size, size, width * spacing[axes.u], height * spacing[axes.v], 0, fontSize * 1.65);
      const { imageWidth, imageHeight } = transform;
      context.imageSmoothingEnabled = false;
      context.drawImage(plane.source, (size - imageWidth) / 2, (size - imageHeight) / 2, imageWidth, imageHeight);
      context.font = `600 ${fontSize}px system-ui`; context.fillStyle = '#edf2f7'; context.textAlign = 'center'; context.textBaseline = 'middle';
      for (const [label, u, v] of [[axes.top, .5, -fontSize * .8 / imageHeight], [axes.bottom, .5, 1 + fontSize * .8 / imageHeight], [axes.left, -fontSize * .8 / imageWidth, .5], [axes.right, 1 + fontSize * .8 / imageWidth, .5]]) context.fillText(label, ...transform.toCanvas(u, v));
      const count = dims[axes.axis]; plane.slider.value = plane.index; plane.output.textContent = `${plane.index + 1} / ${count}`;
      plane.slider.setAttribute('aria-valuetext', `${plane.name} acquired slice ${plane.index + 1} of ${count}`);
      canvas.setAttribute('aria-label', `${plane.series.label}, acquired slice ${plane.index + 1} of ${count}. Original acquisition angle; nearest directions ${axes.top} at top and ${axes.left} at left. Arrow keys browse this independent scan.`);
    }
  }
  startCine() {
    if (this.cine || !this.planes.find(plane => plane.id === this.active)?.volume) return;
    this.cineButton.textContent = `Pause ${this.active}`; this.cineButton.setAttribute('aria-pressed', 'true');
    this.cine = setInterval(() => this.step(this.planes.find(plane => plane.id === this.active), 1, true), 160);
  }
  pause() {
    if (this.cine) clearInterval(this.cine); this.cine = null;
    this.cineButton.textContent = 'Play slices'; this.cineButton.setAttribute('aria-pressed', 'false');
  }
  suspend() {
    this.pause(); this.suspended = true; this.loadToken++; this.fetchController?.abort();
    this.root.removeAttribute('aria-busy'); if (this.frame) { cancelAnimationFrame(this.frame); this.frame = 0; }
  }
  resume() {
    this.suspended = false;
    if (!this.planes.every(plane => plane.volume)) this.load(); else this.scheduleRender();
  }
  reset() {
    this.pause(); this.brightness = 0; this.contrast = 1;
    this.brightnessControl.input.value = 0; this.brightnessControl.output.textContent = '0';
    this.contrastControl.input.value = 100; this.contrastControl.output.textContent = '100%';
    for (const plane of this.planes) if (plane.series) plane.index = plane.series.defaultIndex;
    this.scheduleRender();
  }
  snapshot() {
    if (!this.planes.every(plane => plane.volume)) return;
    this.render(); const result = document.createElement('canvas'); result.width = 1500; result.height = 760;
    const context = result.getContext('2d'); context.fillStyle = '#070b12'; context.fillRect(0, 0, 1500, 760);
    context.fillStyle = '#edf2f7'; context.font = '600 28px system-ui'; context.fillText('MRI / ORIGINAL ACQUIRED SLICES', 36, 48);
    context.fillStyle = '#a1b1c8'; context.font = '18px system-ui'; context.fillText('Independent acquisitions: contrast and slice positions differ.', 36, 80);
    this.planes.forEach((plane, index) => {
      const x = 36 + index * 488;
      context.drawImage(plane.canvas, x, 160, 452, 452); context.fillStyle = '#edf2f7'; context.font = '20px system-ui';
      context.fillText(`${plane.series.label} · ${plane.output.textContent}`, x, 125);
    });
    context.fillStyle = '#a1b1c8'; context.font = '16px system-ui'; context.fillText('512 × 512 acquired pixels · Approx. 0.47 mm pixel spacing · 5 mm slice thickness · Educational viewing', 36, 724);
    result.toBlob(blob => {
      if (!blob || this.disposed) return;
      const url = URL.createObjectURL(blob), link = document.createElement('a'); link.href = url; link.download = 'mri-original-slices.png'; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }, 'image/png');
  }
  destroy() {
    this.disposed = true; this.suspend(); this.events.abort(); this.resizeObserver?.disconnect();
    for (const plane of this.planes) { plane.volume = null; plane.pixels = null; }
    this.root.replaceChildren();
  }
}
