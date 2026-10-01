/**
 * A four-step, click-through explanation of Brain2Print. The drawing is a schematic,
 * not patient data or a segmentation preview. No network requests are made.
 *
 * const destroy = initializeStory(root, { title, intro, chapters });
 * destroy(); // removes listeners and the generated section
 *
 * chapters: four { label, title, body, note? } objects. Defaults follow the
 * Brain2Print / BrainChop workflow without claiming a particular model output.
 */
const mounted = new WeakMap();
const DEFAULT_CHAPTERS = [
  { label: 'Input volume', title: 'Start with the scan.', body: 'An MRI volume stores a stack of measured images. Brain2Print prepares that volume for its model.', note: 'The starting point is the MRI, with its original limits.' },
  { label: 'Tissue estimate', title: 'Let the model label tissue.', body: 'BrainChop predicts tissue labels from the MRI. These are automated estimates, so they need to be checked against the images.', note: 'A prediction is a starting point for inspection.' },
  { label: 'Surface extraction', title: 'Build a surface.', body: 'Brain2Print turns the selected foreground into connected triangles. It can then repair, smooth, and simplify the mesh.', note: 'Smoothing changes the surface; it does not add measured detail.' },
  { label: 'Printable mesh', title: 'Inspect before printing.', body: 'Compare the surface with the source slices, then inspect the STL in a slicer. Check its scale, orientation, supports, and layer preview.', note: 'The final object is for exploration, education, and art.' },
];

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function projectedMesh() {
  const rows = 16, columns = 30, points = [], faces = [];
  const project = (u, v) => {
    const contour = 1 + .04 * Math.cos(5 * u) * Math.sin(v) ** 2;
    const x = 109 * Math.sin(v) * Math.cos(u) * contour;
    const y = 93 * Math.cos(v);
    const z = 74 * Math.sin(v) * Math.sin(u) * contour;
    return { x: 240 + .9 * x + .43 * z, y: 173 + y - .14 * x + .13 * z, depth: z - .4 * x };
  };
  for (let row = 0; row <= rows; row++) {
    points[row] = [];
    for (let column = 0; column <= columns; column++) points[row][column] = project(column / columns * Math.PI * 2, row / rows * Math.PI);
  }
  for (let row = 0; row < rows; row++) for (let column = 0; column < columns; column++) {
    const a = points[row][column], b = points[row + 1][column], c = points[row][column + 1], d = points[row + 1][column + 1];
    for (const vertices of [[a, b, c], [c, b, d]]) {
      const depth = vertices.reduce((sum, point) => sum + point.depth, 0) / 3;
      faces.push({ vertices, depth });
    }
  }
  return faces.sort((a, b) => a.depth - b.depth).map(({ vertices, depth }) => {
    const points = vertices.map(point => `${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(' ');
    const light = Math.max(.18, Math.min(.92, .6 + depth / 270));
    const rgb = [122 + light * 82, 153 + light * 73, 152 + light * 69].map(Math.round);
    return { points, color: `rgb(${rgb.join(',')})` };
  });
}

function diagram() {
  const mesh = projectedMesh();
  let slices = '', labels = '';
  for (let i = 0; i < 9; i++) {
    const y = 104 + i * 17;
    const scale = .59 + .41 * Math.sin((i + 1) / 10 * Math.PI);
    const opacity = .38 + i / 18;
    slices += `<g transform="translate(240 ${y}) scale(${scale} 1)"><ellipse rx="116" ry="33" fill="#162b40" stroke="#8ca7c1" stroke-opacity="${opacity}"/><ellipse rx="89" ry="24" fill="#718398" fill-opacity=".32"/><path d="M-75 0 Q-40 -26 -4 -3 Q33 -25 74 -1 Q45 21 4 4 Q-34 24 -75 0Z" fill="#bbc5cf" fill-opacity=".58"/><path d="M0 -17V18" stroke="#18283b" stroke-width="3"/></g>`;
    labels += `<g transform="translate(240 ${y}) scale(${scale} 1)"><ellipse rx="116" ry="33" fill="#142d35" stroke="#7eadac" stroke-opacity="${opacity}"/><path d="M-77 0 Q-43 -28 -3 -3 Q35 -26 77 -1 Q45 23 3 5 Q-38 24 -77 0Z" fill="#97cfb4" fill-opacity=".81"/><path d="M-52 1 Q-29 -15 -3 -2 Q25 -15 52 0 Q27 14 2 4 Q-27 16 -52 1Z" fill="#bdcfe8" fill-opacity=".93"/><path d="M0 -19V20" stroke="#284940" stroke-width="2"/></g>`;
  }
  const wire = mesh.map(face => `<polygon points="${face.points}" fill="#2b526020" stroke="#a7d0c2" stroke-opacity=".27" stroke-width=".65"/>`).join('');
  const solid = mesh.map(face => `<polygon points="${face.points}" fill="${face.color}" stroke="${face.color}" stroke-width=".3"/>`).join('');
  return `<svg class="b2p-story-svg" viewBox="0 0 480 360" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false">
    <defs><radialGradient id="b2p-illustration-glow"><stop stop-color="#4a8777" stop-opacity=".2"/><stop offset="1" stop-color="#173444" stop-opacity="0"/></radialGradient></defs>
    <ellipse cx="240" cy="193" rx="190" ry="155" fill="url(#b2p-illustration-glow)"/>
    <g fill="none" stroke="#7396b1" stroke-opacity=".12"><path d="M58 303H422M76 279H404M93 255H387M112 231H368"/><path d="M120 322L184 225M200 322L222 225M280 322L259 225M360 322L297 225"/></g>
    <g class="b2p-diagram-scene" data-scene="0">${slices}</g>
    <g class="b2p-diagram-scene" data-scene="1" opacity="0">${labels}</g>
    <g class="b2p-diagram-scene" data-scene="2" opacity="0">${wire}</g>
    <g class="b2p-diagram-scene" data-scene="3" opacity="0">${solid}</g>
  </svg>`;
}

export function initializeStory(root, options = {}) {
  if (!(root instanceof HTMLElement)) throw new TypeError('initializeStory requires an HTML element.');
  mounted.get(root)?.();
  const chapters = options.chapters || DEFAULT_CHAPTERS;
  if (!Array.isArray(chapters) || chapters.length !== 4) throw new TypeError('The story requires four chapters.');
  const section = element('section', 'b2p-story');
  section.setAttribute('aria-label', 'How Brain2Print turns an MRI into a model');
  const heading = element('header', 'b2p-story-heading');
  heading.append(element('p', 'eyebrow', 'FOLLOW THE PROCESS'), element('h2', '', options.title || 'From images to an object.'));
  heading.append(element('p', 'b2p-story-intro', options.intro || 'Choose 01–04 to see how an MRI becomes a printable model. The illustration explains the process; the viewer above shows the actual result.'));
  const layout = element('div', 'b2p-story-layout');
  const visual = element('div', 'b2p-story-visual');
  const visualTop = element('div', 'b2p-story-visual-top');
  visualTop.append(element('span', 'b2p-story-visual-tag', 'PIPELINE ILLUSTRATION'));
  const stepNumber = element('span', 'b2p-story-step-number', '01 / 04');
  visualTop.append(stepNumber);
  const drawing = element('div', 'b2p-story-drawing');
  drawing.innerHTML = diagram();
  // Make SVG definition IDs unique when multiple components are mounted.
  const gradient = drawing.querySelector('radialGradient');
  const gradientID = `b2p-story-glow-${Math.random().toString(36).slice(2)}`;
  gradient.id = gradientID;
  drawing.querySelector('[fill^="url("]').setAttribute('fill', `url(#${gradientID})`);
  const visualLabel = element('p', 'b2p-story-visual-label', chapters[0].label);
  const visualNote = element('p', 'b2p-story-visual-note', 'Schematic shapes, not this scan or its predicted labels.');
  const steps = element('nav', 'b2p-story-steps');
  steps.setAttribute('aria-label', 'Workflow steps');
  const articles = [];
  const buttons = [];
  const chapterList = element('div', 'b2p-story-chapters');
  chapterList.setAttribute('aria-live', 'polite');
  chapterList.setAttribute('aria-atomic', 'true');
  const clickHandlers = [];
  chapters.forEach((chapter, index) => {
    const article = element('article', 'b2p-story-chapter');
    article.dataset.step = String(index);
    article.id = `${gradientID}-step-${index + 1}`;
    article.hidden = index !== 0;
    const chip = element('span', 'b2p-story-chapter-index', `0${index + 1}`);
    const body = element('div', 'b2p-story-chapter-body');
    body.append(element('p', 'b2p-story-chapter-label', chapter.label), element('h3', '', chapter.title), element('p', '', chapter.body));
    if (chapter.note) body.append(element('p', 'b2p-story-chapter-note', chapter.note));
    article.append(chip, body);
    chapterList.append(article);
    articles.push(article);
    const button = element('button', 'b2p-story-step', `0${index + 1}`);
    button.type = 'button';
    button.setAttribute('aria-label', `Step ${index + 1}: ${chapter.label}`);
    button.setAttribute('aria-controls', article.id);
    button.setAttribute('aria-pressed', String(index === 0));
    const handler = () => selectStep(index);
    button.addEventListener('click', handler);
    clickHandlers.push([button, handler]);
    buttons.push(button);
    steps.append(button);
  });
  visual.append(visualTop, drawing, visualLabel, visualNote, steps);
  layout.append(visual, chapterList);
  const limit = element('p', 'b2p-story-limit', options.limit || 'Devin’s scan has 5 mm slices with gaps. Smoothing softens visible steps; it cannot recover detail between slices.');
  const source = element('a', '', 'Brain2Print project ↗');
  source.href = 'https://github.com/niivue/brain2print';
  source.target = '_blank'; source.rel = 'noopener noreferrer';
  limit.append(document.createTextNode(' '), source);
  section.append(heading, layout, limit);
  root.append(section);
  const scenes = [...drawing.querySelectorAll('.b2p-diagram-scene')];
  let destroyed = false;

  function selectStep(active) {
    if (destroyed) return;
    scenes.forEach((scene, index) => scene.setAttribute('opacity', index === active ? '1' : '0'));
    stepNumber.textContent = `0${active + 1} / 04`;
    visualLabel.textContent = chapters[active].label;
    section.style.setProperty('--b2p-progress', String((active + 1) / chapters.length));
    articles.forEach((article, index) => { article.hidden = index !== active; });
    buttons.forEach((button, index) => button.setAttribute('aria-pressed', String(index === active)));
  }
  selectStep(0);
  function destroy() {
    destroyed = true;
    clickHandlers.forEach(([button, handler]) => button.removeEventListener('click', handler));
    section.remove();
    if (mounted.get(root) === destroy) mounted.delete(root);
  }
  mounted.set(root, destroy);
  return destroy;
}
