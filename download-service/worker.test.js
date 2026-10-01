import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { FILE_NAMES, handleRequest, validManifest } from './worker.js';
import { PRIVATE_FILES } from './private-assets-manifest.js';

const ORIGIN = 'https://dev1niscool.github.io';
const TEST_PASSWORD = 'test-fixture-only';
const FILE = 't1-axial.nii.gz';
const COLLECTION = 'devin-mri-nifti-collection.zip';
const parts = Object.values(PRIVATE_FILES).flatMap(file => file.parts);
const partMap = new Map(parts.map((part, index) => [part.path, { ...part, seed: index + 1 }]));

function assetResponse(path, state, { sizeDelta = 0, headerDelta = 0 } = {}) {
  const part = partMap.get(path);
  assert.ok(part, `Unknown private asset ${path}`);
  let sent = 0;
  const size = part.bytes + sizeDelta;
  const body = new ReadableStream({
    pull(controller) {
      if (sent >= size) { controller.close(); return; }
      const count = Math.min(65536, size - sent);
      sent += count;
      state.produced += count;
      controller.enqueue(new Uint8Array(count).fill(part.seed));
    },
    cancel() { state.cancelled.push(path); },
  });
  return new Response(body, { headers: { 'Content-Length': String(part.bytes + headerDelta) } });
}

async function assertFixtureBytes(response, file = FILE) {
  const expected = createHash('sha256');
  for (const part of PRIVATE_FILES[file].parts) expected.update(Buffer.alloc(part.bytes, partMap.get(part.path).seed));
  const actual = createHash('sha256');
  let length = 0;
  for await (const chunk of response.body) { actual.update(chunk); length += chunk.byteLength; }
  assert.equal(length, PRIVATE_FILES[file].bytes);
  assert.equal(actual.digest('hex'), expected.digest('hex'));
}

function fixture(overrides = {}) {
  const calls = { limit: [], get: [] };
  const state = { produced: 0, cancelled: [] };
  const env = {
    ALLOWED_ORIGIN: ORIGIN,
    DOWNLOAD_PASSWORD: TEST_PASSWORD,
    DOWNLOAD_LIMITER: { async limit(input) { calls.limit.push(input); return { success: true }; } },
    PRIVATE_ASSETS: {
      async fetch(assetRequest) {
        assert.equal(assetRequest.method, 'GET');
        assert.deepEqual([...assetRequest.headers], [['accept-encoding', 'identity']]);
        const path = new URL(assetRequest.url).pathname;
        calls.get.push(path);
        return assetResponse(path, state);
      },
    },
    ...overrides,
  };
  return { env, calls, state };
}

function request({ file = FILE, path, method = 'POST', origin = ORIGIN, authorization = `Bearer ${TEST_PASSWORD}`, ip = '192.0.2.15', headers = {} } = {}) {
  const all = new Headers(headers);
  if (origin !== null) all.set('Origin', origin);
  if (authorization !== null) all.set('Authorization', authorization);
  if (ip !== null) all.set('CF-Connecting-IP', ip);
  return new Request(`https://download-service.example${path || `/download/${file}`}`, { method, headers: all });
}

function assertPrivate(response, cors = true) {
  assert.match(response.headers.get('Cache-Control'), /no-store/);
  assert.equal(response.headers.get('CDN-Cache-Control'), 'no-store');
  assert.equal(response.headers.get('X-Content-Type-Options'), 'nosniff');
  assert.equal(response.headers.get('Vary'), 'Origin');
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), cors ? ORIGIN : null);
  assert.equal(response.headers.get('Access-Control-Allow-Credentials'), null);
}

test('allowlist contains exactly the eleven collection files and their ZIP', async () => {
  const collection = JSON.parse(await readFile(new URL('../public/data/nifti-collection.json', import.meta.url)));
  assert.equal(FILE_NAMES.length, 12);
  assert.deepEqual([...FILE_NAMES].sort(), [...collection.files.map(file => file.file), collection.file].sort());
  for (const file of [...collection.files, collection]) {
    assert.equal(PRIVATE_FILES[file.file].bytes, file.bytes);
    assert.equal(PRIVATE_FILES[file.file].sha256, file.sha256);
  }
  assert.equal(validManifest(PRIVATE_FILES), true);
});

test('correct credentials stream unchanged bytes with private attachment headers', async () => {
  const { env, calls, state } = fixture();
  const response = await handleRequest(request(), env);
  assert.equal(response.status, 200);
  assert.ok(state.produced < PRIVATE_FILES[FILE].bytes, 'Body must not be buffered');
  await assertFixtureBytes(response);
  assert.deepEqual(calls.get, [`/files/${FILE}`]);
  assert.deepEqual(calls.limit, [{ key: 'nifti-download:192.0.2.15' }]);
  assert.equal(response.headers.get('Content-Disposition'), 'attachment; filename="Devin-t1-axial.nii.gz"');
  assert.equal(response.headers.get('Content-Type'), 'application/gzip');
  assert.equal(response.headers.get('Content-Length'), String(PRIVATE_FILES[FILE].bytes));
  assert.equal(response.headers.get('Content-Encoding'), null);
  assert.match(response.headers.get('Access-Control-Expose-Headers'), /Content-Disposition/);
  assertPrivate(response);
});

test('all twelve exact names are downloadable and ZIP retains its attachment name', async () => {
  const { env, calls } = fixture();
  for (const file of FILE_NAMES) {
    const response = await handleRequest(request({ file }), env);
    assert.equal(response.status, 200, file);
    await assertFixtureBytes(response, file);
    if (file.endsWith('.zip')) {
      assert.equal(response.headers.get('Content-Type'), 'application/zip');
      assert.equal(response.headers.get('Content-Disposition'), 'attachment; filename="Devin-MRI-NIfTI-collection.zip"');
    }
  }
  assert.deepEqual(calls.get, FILE_NAMES.flatMap(file => PRIVATE_FILES[file].parts.map(part => part.path)));
});

test('missing, wrong, malformed and excessive credentials never read storage', async () => {
  for (const authorization of [null, '', 'Bearer wrong', 'Basic test-fixture-only', 'Bearer test-fixture-only,extra', `Bearer ${'a'.repeat(257)}`]) {
    const { env, calls } = fixture();
    const response = await handleRequest(request({ authorization }), env);
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: 'incorrect_password' });
    assert.equal(calls.limit.length, 1);
    assert.deepEqual(calls.get, []);
    assertPrivate(response);
  }
});

test('password matching is case-sensitive and bearer scheme is case-insensitive', async () => {
  const { env } = fixture();
  assert.equal((await handleRequest(request({ authorization: `bearer ${TEST_PASSWORD}` }), env)).status, 200);
  assert.equal((await handleRequest(request({ authorization: `Bearer ${TEST_PASSWORD.toUpperCase()}` }), env)).status, 401);
});

test('missing, null and foreign origins fail before authentication or storage', async () => {
  for (const origin of [null, 'null', 'https://elsewhere.example', `${ORIGIN}.example`, `${ORIGIN}/`]) {
    const { env, calls } = fixture();
    const response = await handleRequest(request({ origin }), env);
    assert.equal(response.status, 403);
    assertPrivate(response, false);
    assert.deepEqual(calls, { limit: [], get: [] });
  }
});

test('strict CORS preflight permits only the configured origin and POST headers', async () => {
  const { env, calls } = fixture();
  const response = await handleRequest(request({ method: 'OPTIONS', authorization: null, headers: {
    'Access-Control-Request-Method': 'POST',
    'Access-Control-Request-Headers': 'authorization, content-type',
  } }), env);
  assert.equal(response.status, 204);
  assert.equal(response.headers.get('Access-Control-Allow-Methods'), 'POST');
  assert.equal(response.headers.get('Access-Control-Allow-Headers'), 'Authorization, Content-Type');
  assertPrivate(response);
  assert.deepEqual(calls, { limit: [], get: [] });
  for (const headers of [
    { 'Access-Control-Request-Method': 'GET' },
    { 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'x-another-header' },
    {},
  ]) {
    assert.equal((await handleRequest(request({ method: 'OPTIONS', headers }), env)).status, 403);
  }
});

test('local QA origins work only when explicitly configured', async () => {
  for (const origin of ['http://127.0.0.1:8765', 'http://localhost:8765']) {
    const production = fixture();
    assert.equal((await handleRequest(request({ origin }), production.env)).status, 403);
    const local = fixture({ ALLOWED_ORIGIN: origin });
    const response = await handleRequest(request({ origin }), local.env);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('Access-Control-Allow-Origin'), origin);
    assert.equal((await handleRequest(request(), local.env)).status, 403);
    assert.equal((await handleRequest(request({ origin: 'http://localhost:8766' }), local.env)).status, 403);
  }
  for (const origin of ['http://localhost:8766', 'http://127.0.0.1', 'http://example.com', 'http://127.0.0.1:8765/']) {
    const { env } = fixture({ ALLOWED_ORIGIN: origin });
    assert.equal((await handleRequest(request({ origin }), env)).status, 503);
  }
});

test('GET, HEAD and other methods cannot download a file even with credentials', async () => {
  for (const method of ['GET', 'HEAD', 'PUT', 'DELETE', 'PATCH']) {
    const { env, calls } = fixture();
    const response = await handleRequest(request({ method }), env);
    assert.equal(response.status, 405);
    assert.equal(response.headers.get('Allow'), 'POST, OPTIONS');
    assertPrivate(response);
    assert.deepEqual(calls, { limit: [], get: [] });
  }
});

test('unknown keys, path traversal and encoded filenames cannot access private assets', async () => {
  for (const path of [
    '/', '/download/', '/download/secret.nii.gz', '/download/deidentified-dicom.zip',
    '/download/../secret', '/download/%2e%2e/secret', '/download/..%2fsecret',
    '/download/%74%31-axial.nii.gz', '/download//t1-axial.nii.gz',
    '/download/t1-axial.nii.gz/extra', '/download/T1-axial.nii.gz',
  ]) {
    const { env, calls } = fixture();
    const response = await handleRequest(request({ path }), env);
    assert.equal(response.status, 404, path);
    assertPrivate(response);
    assert.deepEqual(calls, { limit: [], get: [] });
  }
});

test('URL query parameters are rejected instead of accepting URL credentials', async () => {
  for (const suffix of ['?password=do-not-use', '?token=do-not-use', '?v=1', '#fragment']) {
    const { env, calls } = fixture();
    const response = await handleRequest(request({ path: `/download/${FILE}${suffix}` }), env);
    assert.equal(response.status, 400);
    assertPrivate(response);
    assert.deepEqual(calls, { limit: [], get: [] });
  }
});

test('missing or invalid secret, asset, limiter and origin bindings fail closed', async () => {
  for (const overrides of [
    { DOWNLOAD_PASSWORD: undefined }, { DOWNLOAD_PASSWORD: '' }, { DOWNLOAD_PASSWORD: 'has spaces' },
    { PRIVATE_ASSETS: undefined }, { PRIVATE_ASSETS: {} },
    { DOWNLOAD_LIMITER: undefined }, { DOWNLOAD_LIMITER: {} },
    { ALLOWED_ORIGIN: undefined }, { ALLOWED_ORIGIN: '*' }, { ALLOWED_ORIGIN: `${ORIGIN}/` },
  ]) {
    const { env, calls } = fixture(overrides);
    const response = await handleRequest(request(), env);
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: 'unavailable' });
    assert.deepEqual(calls.get, []);
    assert.match(response.headers.get('Cache-Control'), /no-store/);
  }
});

test('missing Cloudflare client IP fails closed without trusting forwarded headers', async () => {
  const { env, calls } = fixture();
  const response = await handleRequest(request({ ip: null, headers: { 'X-Forwarded-For': '192.0.2.99' } }), env);
  assert.equal(response.status, 503);
  assertPrivate(response);
  assert.deepEqual(calls, { limit: [], get: [] });
});

test('rate limit blocks even correct passwords without reading objects', async () => {
  const { env, calls } = fixture({ DOWNLOAD_LIMITER: { async limit() { return { success: false }; } } });
  const response = await handleRequest(request(), env);
  assert.equal(response.status, 429);
  assert.equal(response.headers.get('Retry-After'), '60');
  assert.deepEqual(await response.json(), { error: 'too_many_attempts' });
  assertPrivate(response);
  assert.deepEqual(calls.get, []);
});

test('malformed limiter replies also fail closed', async () => {
  for (const result of [null, undefined, {}, { success: 'true' }]) {
    const { env, calls } = fixture({ DOWNLOAD_LIMITER: { async limit() { return result; } } });
    const response = await handleRequest(request(), env);
    assert.equal(response.status, 429);
    assert.deepEqual(calls.get, []);
  }
});

test('a limiter exception returns a private generic failure without reading assets', async () => {
  const { env, calls } = fixture({ DOWNLOAD_LIMITER: { async limit() { throw new Error('private infrastructure error'); } } });
  const response = await handleRequest(request(), env);
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: 'unavailable' });
  assertPrivate(response);
  assert.deepEqual(calls.get, []);
});

test('limiter uses the same IP key across files, and distinct keys for distinct IPs', async () => {
  const { env, calls } = fixture();
  await handleRequest(request(), env);
  await handleRequest(request({ file: FILE_NAMES[1] }), env);
  await handleRequest(request({ ip: '2001:db8::1' }), env);
  assert.deepEqual(calls.limit.map(call => call.key), [
    'nifti-download:192.0.2.15', 'nifti-download:192.0.2.15', 'nifti-download:2001:db8::1',
  ]);
});

test('storage failures and missing assets return a generic private failure', async () => {
  for (const fetch of [
    async () => new Response('Not found', { status: 404 }),
    async () => new Response(null, { status: 200 }),
    async () => { throw new Error(`sensitive error ${TEST_PASSWORD}`); },
  ]) {
    const { env } = fixture({ PRIVATE_ASSETS: { fetch } });
    const response = await handleRequest(request(), env);
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: 'unavailable' });
    assertPrivate(response);
  }
});

test('client Range and conditional headers never reach the private binding', async () => {
  const { env, calls } = fixture();
  const response = await handleRequest(request({ headers: { Range: 'bytes=0-0', 'If-None-Match': '*', Cookie: 'anything=anything' } }), env);
  assert.equal(response.status, 200);
  await assertFixtureBytes(response);
  assert.deepEqual(calls.get, [`/files/${FILE}`]);
});

test('deployment configuration routes every asset request through authentication', async () => {
  const config = JSON.parse(await readFile(new URL('./wrangler.jsonc', import.meta.url)));
  assert.equal(config.assets.run_worker_first, true);
  assert.equal(config.assets.binding, 'PRIVATE_ASSETS');
  assert.equal(config.assets.directory, '../../private-mri-assets');
  assert.equal(config.assets.html_handling, 'none');
  assert.equal(config.assets.not_found_handling, 'none');
  assert.equal(config.preview_urls, false);
  assert.equal(config.observability.enabled, false);
  assert.equal(config.vars.ALLOWED_ORIGIN, ORIGIN);
  assert.equal(config.r2_buckets, undefined);
  assert.equal(config.vars.DOWNLOAD_PASSWORD, undefined);
  assert.ok(config.compatibility_flags.includes('enable_request_signal'));
});

test('direct internal asset URLs never call the binding, even with the password', async () => {
  for (const path of [`/files/${FILE}`, '/collection/part-000', '/collection/part-003', '/files/%74%31-axial.nii.gz', '/404.html']) {
    for (const method of ['GET', 'HEAD', 'POST']) {
      const { env, calls } = fixture();
      const response = await handleRequest(request({ path, method, headers: { 'Sec-Fetch-Mode': 'navigate' } }), env);
      assert.equal(response.status, 404);
      assertPrivate(response);
      assert.deepEqual(calls, { limit: [], get: [] });
    }
  }
});

test('manifest rejects changed paths, missing hashes and inconsistent parts', () => {
  for (const modify of [
    manifest => delete manifest[FILE],
    manifest => { manifest['unlisted.nii.gz'] = manifest[FILE]; },
    manifest => { manifest[FILE].parts[0].path = '/other/secret'; },
    manifest => { manifest[FILE].parts[0].bytes += 1; },
    manifest => { manifest[FILE].parts[0].sha256 = 'missing'; },
    manifest => { manifest[FILE].parts[0] = null; },
    manifest => { manifest[COLLECTION].parts.reverse(); },
    manifest => { manifest[COLLECTION].parts.pop(); },
    manifest => { manifest[COLLECTION].bytes += 1; },
  ]) {
    const manifest = structuredClone(PRIVATE_FILES);
    modify(manifest);
    assert.equal(validManifest(manifest), false);
  }
});

test('all four collection responses are checked before returning headers; failure cancels the others', async () => {
  const { env, state } = fixture();
  const originalFetch = env.PRIVATE_ASSETS.fetch;
  env.PRIVATE_ASSETS.fetch = assetRequest => new URL(assetRequest.url).pathname.endsWith('part-002')
    ? new Response('Missing', { status: 404 }) : originalFetch(assetRequest);
  const response = await handleRequest(request({ file: COLLECTION }), env);
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: 'unavailable' });
  assertPrivate(response);
  assert.deepEqual(state.cancelled.sort(), ['/collection/part-000', '/collection/part-001', '/collection/part-003']);
});

test('incorrect or malformed asset Content-Length, encoding, or redirect fails before the download starts', async () => {
  for (const change of [
    response => response.headers.set('Content-Length', ''),
    response => response.headers.set('Content-Length', 'not-a-length'),
    response => response.headers.set('Content-Length', '-1'),
    response => response.headers.set('Content-Length', '1'),
    response => response.headers.set('Content-Encoding', 'gzip'),
  ]) {
    const { env, state } = fixture();
    env.PRIVATE_ASSETS.fetch = () => {
      const response = assetResponse(`/files/${FILE}`, state);
      change(response);
      return response;
    };
    const response = await handleRequest(request(), env);
    assert.equal(response.status, 503);
    assert.deepEqual(state.cancelled, [`/files/${FILE}`]);
  }
  const { env } = fixture({ PRIVATE_ASSETS: { fetch: async () => new Response(null, { status: 302, headers: { Location: 'https://other.example' } }) } });
  assert.equal((await handleRequest(request(), env)).status, 503);
});

test('truncated or oversized asset streams fail instead of producing a silently corrupted download', async () => {
  for (const sizeDelta of [-1, 1]) {
    const { env, state } = fixture();
    env.PRIVATE_ASSETS.fetch = () => assetResponse(`/files/${FILE}`, state, { sizeDelta });
    const response = await handleRequest(request(), env);
    assert.equal(response.status, 200);
    await assert.rejects(response.arrayBuffer(), /asset/i);
  }
});

test('cancelling a collection download cancels every remaining upstream part', async () => {
  const { env, state } = fixture();
  const response = await handleRequest(request({ file: COLLECTION }), env);
  assert.equal(response.status, 200);
  const reader = response.body.getReader();
  await reader.read();
  await reader.cancel('Visitor cancelled');
  assert.deepEqual(state.cancelled.sort(), PRIVATE_FILES[COLLECTION].parts.map(part => part.path));
  assert.ok(state.produced < 1024 * 1024, 'Cancelling must not read the entire archive');
});

test('an aborted download request cancels upstream streams', async () => {
  const { env, state } = fixture();
  const abort = new AbortController();
  const req = new Request(request({ file: COLLECTION }), { signal: abort.signal });
  const response = await handleRequest(req, env);
  const reader = response.body.getReader();
  await reader.read();
  abort.abort();
  await assert.rejects(async () => { while (!(await reader.read()).done) {} }, /cancelled/);
  assert.deepEqual(state.cancelled.sort(), PRIVATE_FILES[COLLECTION].parts.map(part => part.path));
});

test('assets without Content-Length stream exact file and collection bytes', async () => {
  for (const file of [FILE, COLLECTION]) {
    const { env } = fixture();
    const originalFetch = env.PRIVATE_ASSETS.fetch;
    env.PRIVATE_ASSETS.fetch = async req => {
      const response = await originalFetch(req);
      response.headers.delete('Content-Length');
      return response;
    };
    const response = await handleRequest(request({ file }), env);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('Content-Length'), String(PRIVATE_FILES[file].bytes));
    await assertFixtureBytes(response, file);
  }
});

test('unadvertised asset lengths still detect truncated and oversized streams', async () => {
  for (const sizeDelta of [-1, 1]) {
    const { env, state } = fixture();
    env.PRIVATE_ASSETS.fetch = () => {
      const response = assetResponse(`/files/${FILE}`, state, { sizeDelta });
      response.headers.delete('Content-Length');
      return response;
    };
    const response = await handleRequest(request(), env);
    assert.equal(response.status, 200);
    await assert.rejects(response.arrayBuffer(), /asset/i);
  }
});

test('older runtimes without an incoming signal still stream safely', async () => {
  const { env } = fixture();
  const req = request();
  Object.defineProperty(req, 'signal', { get() { throw new Error('signal not supported'); } });
  const response = await handleRequest(req, env);
  assert.equal(response.status, 200);
  await assertFixtureBytes(response);
});
