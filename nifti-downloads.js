import { downloadProtectedFile } from './nifti-download-provider.js';

const dialog = document.querySelector('#nifti-download-dialog');
const form = document.querySelector('#nifti-download-form');
const passwordInput = document.querySelector('#nifti-download-password');
const fileLabel = document.querySelector('#nifti-download-file');
const status = document.querySelector('#nifti-download-status');
const progress = document.querySelector('#nifti-download-progress');
const submit = document.querySelector('#nifti-download-submit');
let selection = null;
let activeRequest = null;

function setBusy(busy) {
  submit.setAttribute('aria-busy', String(busy));
  passwordInput.disabled = busy;
  submit.disabled = busy || passwordInput.value.length === 0;
  submit.firstChild.textContent = busy ? 'Preparing… ' : 'Download ';
}

function resetForm() {
  passwordInput.value = '';
  passwordInput.removeAttribute('aria-invalid');
  status.textContent = '';
  status.classList.remove('is-error');
  progress.hidden = true;
  progress.removeAttribute('value');
  setBusy(false);
}

function dismiss() {
  const returnFocus = selection?.button;
  activeRequest?.abort();
  activeRequest = null;
  selection = null;
  resetForm();
  dialog.close();
  returnFocus?.focus({ preventScroll: true });
}

document.querySelectorAll('[data-nifti-file]').forEach((button) => {
  button.addEventListener('click', () => {
    activeRequest?.abort();
    activeRequest = null;
    resetForm();
    selection = {
      button,
      file: button.dataset.niftiFile,
      name: button.dataset.niftiDownloadName,
    };
    fileLabel.textContent = selection.name;
    dialog.showModal();
    passwordInput.focus();
  });
});

dialog.querySelectorAll('[data-nifti-cancel]').forEach((button) => {
  button.addEventListener('click', dismiss);
});
dialog.addEventListener('cancel', (event) => {
  event.preventDefault();
  dismiss();
});
dialog.addEventListener('close', () => {
  // Also clear secrets if another part of the page closes the native dialog.
  if (!dialog.open && selection) dismiss();
});
passwordInput.addEventListener('input', () => {
  submit.disabled = passwordInput.value.length === 0 || Boolean(activeRequest);
  passwordInput.removeAttribute('aria-invalid');
  if (status.classList.contains('is-error')) {
    status.textContent = '';
    status.classList.remove('is-error');
  }
});

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!selection || activeRequest || !passwordInput.value) return;

  const request = new AbortController();
  const { file, name } = selection;
  activeRequest = request;
  let password = passwordInput.value;
  passwordInput.value = '';
  passwordInput.removeAttribute('aria-invalid');
  status.classList.remove('is-error');
  status.textContent = 'Preparing your download…';
  progress.hidden = false;
  progress.removeAttribute('value');
  setBusy(true);

  try {
    const blob = await downloadProtectedFile({
      file,
      password,
      signal: request.signal,
      onProgress(update = {}) {
        if (activeRequest !== request || request.signal.aborted) return;
        const loaded = Number(update.loaded ?? update.received);
        const total = Number(update.total);
        if (Number.isFinite(loaded) && Number.isFinite(total) && total > 0) {
          const fraction = Math.max(0, Math.min(1, loaded / total));
          progress.value = fraction;
          const percentage = Math.round(fraction * 100);
          const nextStatus = `Downloading… ${percentage}%`;
          if (status.textContent !== nextStatus) status.textContent = nextStatus;
        } else if (update.message) {
          status.textContent = update.message;
        }
      },
    });
    if (activeRequest !== request || request.signal.aborted) return;
    if (!(blob instanceof Blob)) throw new Error('Download did not return a file.');

    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = name;
    link.hidden = true;
    document.body.append(link);
    link.click();
    link.remove();
    // Leave time for browsers to start saving larger files before releasing them.
    window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
    dismiss();
  } catch (error) {
    if (activeRequest !== request || request.signal.aborted) return;
    progress.hidden = true;
    status.classList.add('is-error');
    if (error.code === 'wrong-password') {
      status.textContent = 'That password isn’t correct. Please try again.';
      passwordInput.setAttribute('aria-invalid', 'true');
    } else if (error.code === 'configuration') {
      status.textContent = 'Downloads are being set up. Please try again later.';
    } else if (error.code === 'rate-limit') {
      status.textContent = 'Too many attempts. Wait a minute, then try again.';
    } else {
      status.textContent = 'The file could not be downloaded. Please try again.';
    }
    setBusy(false);
    passwordInput.focus();
  } finally {
    password = '';
    if (activeRequest === request) {
      activeRequest = null;
      setBusy(false);
    }
  }
});

window.addEventListener('pagehide', () => {
  activeRequest?.abort();
  activeRequest = null;
  resetForm();
});
