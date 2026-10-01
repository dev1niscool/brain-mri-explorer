/** A short printer vignette using the actual captured-head preview. */
export class PrintIntro {
  constructor(stage) {
    this.stage = stage;
    this.overlay = stage.querySelector('#print-intro');
    this.content = stage.querySelector('#print-content');
    this.image = stage.querySelector('#printer-head-preview');
    this.welcome = document.querySelector('#welcome-screen');
    this.motion = matchMedia('(prefers-reduced-motion: reduce)');
    this.active = false;
    this.pending = false;
    this.ready = false;
    this.playing = false;
    this.entry = 0;
    this.timer = null;
    document.addEventListener('keydown', event => {
      if (this.playing && event.key === 'Escape') { event.preventDefault(); this.finish(); }
    });
    this.motion.addEventListener('change', () => { if (this.motion.matches) this.finish(); });
    if (this.welcome) {
      // Mutation observers run after welcome.js restores the page's focus and inert state.
      this.welcomeObserver = new MutationObserver(() => this.tryStart());
      this.welcomeObserver.observe(this.welcome, {attributes: true, attributeFilter: ['hidden']});
    }
  }

  setActive(active) {
    if (this.active === active) return;
    this.entry++;
    this.active = active;
    this.finish();
    this.pending = active;
    this.tryStart();
  }

  async setPreview(url) {
    this.image.src = url;
    try {
      await this.image.decode();
      this.ready = true;
      this.tryStart();
    } catch {
      // A missing preview must never hide the downloadable models.
      this.ready = false;
      this.finish();
    }
  }

  tryStart() {
    if (!this.active || !this.pending || this.playing || !this.ready || (this.welcome && !this.welcome.hidden)) return;
    this.pending = false;
    if (this.motion.matches) return;
    this.playing = true;
    const entry = this.entry;
    this.content.inert = true;
    this.overlay.hidden = false;
    this.stage.classList.add('is-printing');
    this.stage.setAttribute('aria-busy', 'true');
    this.timer = setTimeout(() => { if (entry === this.entry) this.finish(); }, 1300);
  }

  finish() {
    clearTimeout(this.timer);
    this.timer = null;
    this.pending = false;
    const restoreFocus = this.overlay.contains(document.activeElement);
    this.playing = false;
    this.stage.classList.remove('is-printing');
    this.stage.removeAttribute('aria-busy');
    this.overlay.hidden = true;
    this.content.inert = false;
    if (restoreFocus) document.querySelector('.tab.active')?.focus({preventScroll: true});
  }
}
