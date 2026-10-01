const files = new Set([
  't1-axial.nii.gz', 't1-sagittal.nii.gz', 't2-axial.nii.gz',
  'flair-axial.nii.gz', 'flair-coronal.nii.gz', 'merge-axial.nii.gz',
  'dwi-b1000.nii.gz', 'dwi-reference.nii.gz', 'adc.nii.gz',
  'b2p-conformed.nii.gz', 'b2p-segmentation.nii.gz',
  'devin-mri-nifti-collection.zip',
]);

function failure(message, code) {
  return Object.assign(new Error(message), { code });
}

export async function downloadProtectedFile({ file, password, signal, onProgress = () => {} }) {
  if (!files.has(file)) throw failure('This download is unavailable.', 'invalid-file');
  const configResponse = await fetch(new URL('./download-service.json', import.meta.url), {
    signal, cache: 'no-store', credentials: 'omit',
  });
  if (!configResponse.ok) throw failure('Downloads could not connect. Please try again.', 'configuration');
  const config = await configResponse.json();
  if (!config.endpoint) throw failure('Protected downloads are being connected. Please try again later.', 'configuration');
  const endpoint = new URL(config.endpoint);
  const local = ['localhost', '127.0.0.1'].includes(location.hostname)
    && ['localhost', '127.0.0.1'].includes(endpoint.hostname);
  if ((endpoint.protocol !== 'https:' && !local) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw failure('The download service address is invalid.', 'configuration');
  }
  onProgress({ message: 'Checking password…' });
  const response = await fetch(new URL(`download/${encodeURIComponent(file)}`, endpoint.href.replace(/\/?$/, '/')), {
    method: 'POST', headers: { Authorization: `Bearer ${password}` },
    mode: 'cors', credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer', signal,
  });
  if (response.status === 401) throw failure('That password wasn’t correct. Try again.', 'wrong-password');
  if (response.status === 429) throw failure('Too many attempts. Please wait a minute and try again.', 'rate-limit');
  if (!response.ok || !response.body) throw failure('The download could not start. Please try again.', 'download');
  const total = Number(response.headers.get('content-length')) || 0;
  const reader = response.body.getReader();
  const chunks = [];
  let loaded = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value); loaded += value.byteLength;
      onProgress({ loaded, total, message: 'Downloading…' });
    }
  } finally {
    reader.releaseLock();
  }
  signal?.throwIfAborted();
  if (!loaded || (total && loaded !== total)) throw failure('The download was interrupted. Please try again.', 'download');
  return new Blob(chunks, { type: file.endsWith('.zip') ? 'application/zip' : 'application/gzip' });
}
