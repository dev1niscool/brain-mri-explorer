/* A brief introduction. MRI loading proceeds independently. */
(() => {
  const screen = document.querySelector('#welcome-screen');
  if (!screen) return;
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const page = [...document.querySelectorAll('.skip-link, .site-header, main, .site-footer')];
  let dismissed = false;
  let timer;

  function finish() {
    if (dismissed) return;
    dismissed = true;
    clearTimeout(timer);
    document.removeEventListener('keydown', onKey);
    screen.classList.add('welcome-leaving');
    const restoreFocus = screen.contains(document.activeElement);
    // Leave the underlying page inert until the overlay has finished fading.
    setTimeout(() => {
      screen.hidden = true;
      document.body.classList.remove('welcoming');
      page.forEach(element => { element.inert = false; });
      if (restoreFocus) document.querySelector('.tab.active')?.focus({preventScroll: true});
    }, reducedMotion ? 0 : 225);
  }

  function onKey(event) {
    if (event.key === 'Escape') { event.preventDefault(); finish(); }
    // Keep focus on the brief modal until it automatically reveals the page.
    if (event.key === 'Tab' && !dismissed) { event.preventDefault(); screen.focus(); }
  }

  screen.hidden = false;
  document.body.classList.add('welcoming');
  page.forEach(element => { element.inert = true; });
  document.addEventListener('keydown', onKey);
  screen.focus({preventScroll: true});
  timer = setTimeout(finish, reducedMotion ? 350 : 2500);
})();
