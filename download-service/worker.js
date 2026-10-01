import { timingSafeEqual } from 'node:crypto';
import { PRIVATE_FILES } from './private-assets-manifest.js';

// These keys match nifti-collection.json. Never accept a caller-supplied asset path.
export const FILE_NAMES = Object.freeze([
  't1-axial.nii.gz',
  't2-axial.nii.gz',
  'flair-axial.nii.gz',
  't1-sagittal.nii.gz',
  'flair-coronal.nii.gz',
  'merge-axial.nii.gz',
  'dwi-b1000.nii.gz',
  'dwi-reference.nii.gz',
  'adc.nii.gz',
  'b2p-conformed.nii.gz',
  'b2p-segmentation.nii.gz',
  'devin-mri-nifti-collection.zip',
]);
const FILES = new Set(FILE_NAMES);
const encoder = new TextEncoder();
const COLLECTION = 'devin-mri-nifti-collection.zip';
const PART_BYTES = 20 * 1024 * 1024;

export function validManifest(manifest) {
  if (!manifest || Object.keys(manifest).length !== FILE_NAMES.length) return false;
  return FILE_NAMES.every(name => {
    const file = manifest[name];
    if (!file || !Number.isSafeInteger(file.bytes) || file.bytes <= 0 || !/^[a-f0-9]{64}$/.test(file.sha256)) return false;
    const collection = name === COLLECTION;
    if (!Array.isArray(file.parts) || file.parts.length !== (collection ? 4 : 1)) return false;
    if (collection && file.bytes !== 74224408) return false;
    return file.parts.every((part, index) => {
      if (!part || typeof part !== 'object') return false;
      const path = collection ? `/collection/part-${String(index).padStart(3, '0')}` : `/files/${name}`;
      const bytes = collection ? Math.min(PART_BYTES, file.bytes - index * PART_BYTES) : file.bytes;
      return part.path === path && part.bytes === bytes && bytes > 0 && bytes < 25 * 1024 * 1024
        && /^[a-f0-9]{64}$/.test(part.sha256)
        && (collection || part.sha256 === file.sha256);
    }) && file.parts.reduce((total, part) => total + part.bytes, 0) === file.bytes;
  });
}

const manifestValid = validManifest(PRIVATE_FILES);

async function cancelBodies(responses, reason) {
  await Promise.allSettled(responses.filter(response => response?.body).map(response => response.body.cancel(reason)));
}

function concatenateParts(responses, parts, signal) {
  const readers = responses.map(response => response.body.getReader());
  let index = 0;
  let received = 0;
  let stopped = false;
  let onAbort;
  const cleanup = () => signal?.removeEventListener('abort', onAbort);
  const cancelReaders = async reason => {
    if (stopped) return;
    stopped = true;
    cleanup();
    await Promise.allSettled(readers.filter(Boolean).map(reader => reader.cancel(reason)));
  };
  return new ReadableStream({
    start(controller) {
      onAbort = () => {
        const error = new DOMException('Download cancelled', 'AbortError');
        void cancelReaders(error).then(() => controller.error(error));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) onAbort();
    },
    async pull(controller) {
      if (stopped) return;
      try {
        while (index < readers.length) {
          const { value, done } = await readers[index].read();
          if (stopped) return;
          if (done) {
            if (received !== parts[index].bytes) throw new Error('Incomplete asset');
            readers[index].releaseLock();
            readers[index] = null;
            received = 0;
            index += 1;
            continue;
          }
          received += value.byteLength;
          if (received > parts[index].bytes) throw new Error('Unexpected asset length');
          controller.enqueue(value);
          return;
        }
        stopped = true;
        cleanup();
        controller.close();
      } catch (error) {
        await cancelReaders(error);
        controller.error(error);
      }
    },
    cancel: cancelReaders,
  });
}

async function privateFileStream(file, request, env) {
  let signal;
  try { signal = request.signal; } catch { /* Older runtimes may not expose an incoming signal. */ }
  // All part headers must pass before returning the download. Fetch only through
  // the private binding, with no visitor authorization/cookies forwarded.
  const results = await Promise.allSettled(file.parts.map(part => env.PRIVATE_ASSETS.fetch(
    new Request(`https://private-assets.internal${part.path}`, {
      headers: { 'Accept-Encoding': 'identity' }, signal, redirect: 'manual',
    }),
  )));
  const responses = results.map(result => result.status === 'fulfilled' ? result.value : null);
  const invalidPart = results.findIndex((result, index) => {
    const response = responses[index];
    if (result.status !== 'fulfilled' || !(response instanceof Response)) return true;
    const size = response.headers.get('Content-Length');
    const encoding = response.headers.get('Content-Encoding');
    return !(response.status === 200 && response.body
      && (size === null || (/^\d+$/.test(size) && Number(size) === file.parts[index].bytes))
      && (!encoding || encoding === 'identity'));
  });
  if (invalidPart !== -1 || signal?.aborted) {
    await cancelBodies(responses, 'Asset unavailable');
    throw new Error('Asset unavailable');
  }
  return concatenateParts(responses, file.parts, signal);
}

function responseHeaders(origin) {
  const headers = new Headers({
    'Cache-Control': 'no-store, max-age=0',
    'CDN-Cache-Control': 'no-store',
    'Pragma': 'no-cache',
    'Vary': 'Origin',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  });
  if (origin) {
    headers.set('Access-Control-Allow-Origin', origin);
    headers.set('Access-Control-Expose-Headers', 'Content-Disposition, Content-Length, Retry-After');
  }
  return headers;
}

function errorResponse(status, error, origin, extraHeaders = {}) {
  const headers = responseHeaders(origin);
  headers.set('Content-Type', 'application/json; charset=utf-8');
  for (const [name, value] of Object.entries(extraHeaders)) headers.set(name, value);
  return new Response(JSON.stringify({ error }), { status, headers });
}

function validOrigin(origin) {
  if (typeof origin !== 'string') return false;
  // Local full-stack QA is opt-in through configuration, never by reflecting a
  // request's Origin header. Production keeps the GitHub Pages HTTPS origin.
  if (origin === 'http://127.0.0.1:8765' || origin === 'http://localhost:8765') return true;
  try {
    const url = new URL(origin);
    return url.protocol === 'https:' && url.origin === origin;
  } catch {
    return false;
  }
}

async function passwordMatches(authorization, expected) {
  // Hash to fixed-size buffers before the native timing-safe comparison. The
  // password itself is supplied only through the encrypted Worker secret.
  const match = /^Bearer ([^\s,]{1,256})$/i.exec(authorization || '');
  const supplied = match ? match[1] : '';
  const [actualDigest, expectedDigest] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(supplied)),
    crypto.subtle.digest('SHA-256', encoder.encode(expected)),
  ]);
  const equal = timingSafeEqual(new Uint8Array(actualDigest), new Uint8Array(expectedDigest));
  return equal && match !== null;
}

export async function handleRequest(request, env) {
  const allowedOrigin = env?.ALLOWED_ORIGIN;
  if (!validOrigin(allowedOrigin)) return errorResponse(503, 'unavailable');
  if (request.headers.get('Origin') !== allowedOrigin) return errorResponse(403, 'origin_not_allowed');
  const origin = allowedOrigin;
  let url;
  try {
    url = new URL(request.url);
  } catch {
    return errorResponse(400, 'invalid_request', origin);
  }
  // No passwords, tokens, aliases, encoded paths, or other parameters in URLs.
  if (url.search || url.hash) return errorResponse(400, 'invalid_request', origin);
  const key = url.pathname.startsWith('/download/') ? url.pathname.slice(10) : '';
  if (!FILES.has(key)) return errorResponse(404, 'not_found', origin);

  if (request.method === 'OPTIONS') {
    const requestedMethod = request.headers.get('Access-Control-Request-Method');
    const requestedHeaders = (request.headers.get('Access-Control-Request-Headers') || '')
      .split(',').map(value => value.trim().toLowerCase()).filter(Boolean);
    if (requestedMethod !== 'POST' || requestedHeaders.some(name => !['authorization', 'content-type'].includes(name))) {
      return errorResponse(403, 'preflight_not_allowed', origin);
    }
    const headers = responseHeaders(origin);
    headers.set('Access-Control-Allow-Methods', 'POST');
    headers.set('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    return new Response(null, { status: 204, headers });
  }
  if (request.method !== 'POST') return errorResponse(405, 'method_not_allowed', origin, { Allow: 'POST, OPTIONS' });
  if (typeof env.DOWNLOAD_PASSWORD !== 'string' || !/^[^\s,]{1,256}$/.test(env.DOWNLOAD_PASSWORD)
      || !manifestValid || typeof env.PRIVATE_ASSETS?.fetch !== 'function'
      || typeof env.DOWNLOAD_LIMITER?.limit !== 'function') {
    return errorResponse(503, 'unavailable', origin);
  }

  // Cloudflare supplies this header. Do not substitute user-controlled forwarded
  // headers or a shared fallback key when it is absent.
  const ip = request.headers.get('CF-Connecting-IP');
  if (!ip || ip.length > 64) return errorResponse(503, 'unavailable', origin);
  try {
    const limit = await env.DOWNLOAD_LIMITER.limit({ key: `nifti-download:${ip}` });
    if (limit?.success !== true) {
      return errorResponse(429, 'too_many_attempts', origin, { 'Retry-After': '60' });
    }
    if (!await passwordMatches(request.headers.get('Authorization'), env.DOWNLOAD_PASSWORD)) {
      return errorResponse(401, 'incorrect_password', origin);
    }
    const file = PRIVATE_FILES[key];
    let body = await privateFileStream(file, request, env);
    // Workers derives Content-Length from this stream type; manually assigning
    // that header alone is ignored by the runtime. Node tests use the standard
    // stream fallback, which still checks every part's byte count.
    if (typeof FixedLengthStream !== 'undefined') {
      const fixed = new FixedLengthStream(file.bytes);
      void body.pipeTo(fixed.writable).catch(() => {});
      body = fixed.readable;
    }
    const headers = responseHeaders(origin);
    headers.set('Content-Type', key.endsWith('.zip') ? 'application/zip' : 'application/gzip');
    const filename = key.endsWith('.zip') ? 'Devin-MRI-NIfTI-collection.zip' : `Devin-${key}`;
    headers.set('Content-Disposition', `attachment; filename="${filename}"`);
    headers.set('Content-Length', String(file.bytes));
    // Stream parts in order with backpressure; never buffer the 74 MB archive.
    // Asset metadata cannot override the authentication or cache headers.
    return new Response(body, { headers });
  } catch {
    // Do not log requests, authorization headers, credentials, or storage errors.
    return errorResponse(503, 'unavailable', origin);
  }
}

export default { fetch: handleRequest };
