# Private NIfTI downloads

This Cloudflare Worker serves eleven MRI NIfTI files and their collection ZIP after checking a shared password. Original file bytes are deployed as protected Worker assets from a directory outside the public Git repository. No R2 subscription is required.

## Access boundary

`assets.run_worker_first` **must remain the boolean `true`**. It makes the Worker run before every incoming request, including requests whose paths match an asset. A selective route array is not sufficient. The handler rejects every path except its twelve `/download/<filename>` endpoints; it never falls back to serving arbitrary assets. Direct `/files/*` and `/collection/*` requests are rejected, even with credentials.

Only after checking the allowed origin, rate limiter and password does the handler call `PRIVATE_ASSETS.fetch()` internally. These binding requests do not forward the visitor's password, cookies, range, or conditional headers. Asset headers cannot override the download's cache policy. Preview URLs and Workers observability are disabled, and the code writes no logs.

The password is stored only in the encrypted `DOWNLOAD_PASSWORD` Worker secret. Supplied and expected passwords are hashed into fixed-length SHA-256 buffers and compared using native `timingSafeEqual`. The secret is never included in source, URLs, cookies, or application logs.

## API

`POST https://<worker-host>/download/<filename>` with:

- `Origin: https://dev1niscool.github.io` (added by the browser)
- `Authorization: Bearer <entered-password>`
- No query parameters or request body.

The twelve filenames are in `FILE_NAMES` in `worker.js`. They match `public/data/nifti-collection.json`; the tests verify that match. Success returns an attachment with `Cache-Control: no-store`. The frontend saves the response as a Blob and clears the entered password afterward. CORS exposes the attachment filename, content length, and retry delay.

| Status | Meaning |
| --- | --- |
| 401 | `incorrect_password` |
| 403 | Origin or preflight rejected |
| 404 | Path or filename is not allowed |
| 405 | Only POST and OPTIONS are accepted |
| 429 | `too_many_attempts`; wait 60 seconds |
| 503 | `unavailable`; configuration, limiter or asset failed |

Errors are JSON `{ "error": "<code>" }`. CORS is an additional browser restriction; the password provides access control. Requests without Cloudflare's client-IP header fail closed. The Worker never trusts a caller-supplied forwarding header as a fallback.

## Files and streaming

The configured asset directory is `../../private-mri-assets`, outside the website repository:

- `files/<original filename>` contains each of the eleven unchanged `.nii.gz` files.
- `collection/part-000` through `part-003` contain consecutive portions of the unchanged ZIP: three 20 MiB parts and one 11,309,848-byte part.
- `private-assets-manifest.js` contains only paths, byte lengths and SHA-256 hashes; it contains no image bytes or secrets.

The manifest enforces exact filenames, internal paths, part counts and byte totals. The ZIP is 74,224,408 bytes. Before returning download headers, the Worker fetches all required asset responses and verifies their status, any supplied Content-Length, and lack of transfer compression. The Cloudflare asset binding may omit Content-Length; actual byte counts and the fixed-length output stream still enforce the manifest sizes. It then streams their bodies in order, checks each actual byte count, and cancels upstream reads if the visitor cancels. It never buffers the full archive. A Cloudflare `FixedLengthStream` supplies the correct outgoing Content-Length.

Hashes are verified during asset preparation and deployment validation, rather than hashing a 74 MB archive on every request. An authorized full ZIP download must match the original collection hash in `nifti-collection.json`.

## Deployment

Use Node 22+ and the authorized Cloudflare account. Run these steps from this directory:

1. Sign in with `npx wrangler@4 login`; confirm the account with `npx wrangler@4 whoami`.
2. Prepare the protected asset directory outside the public repository and its manifest. Check all original hashes and sizes against `nifti-collection.json`, then verify that concatenating the four collection parts reproduces the original ZIP hash. Never copy the asset directory into GitHub Pages or the public repository.
3. Review `wrangler.jsonc`: unconditional `run_worker_first:true`, the `PRIVATE_ASSETS` binding, no HTML or not-found fallback, disabled preview URLs, and the exact allowed origin are required.
4. Run `npm test` and `npm run check`.
5. Publish with `npm run deploy`. Missing secrets or bindings cause downloads to fail closed.
6. Set the password with `npx wrangler@4 secret put DOWNLOAD_PASSWORD`, entering it at the hidden prompt. Do not put it in command arguments, config, source or logs.
7. Configure the public website's provider with the deployed HTTPS Worker origin. Test preflight, an incorrect password, direct internal asset URLs, and complete authenticated NIfTI and ZIP downloads. Compare the downloaded hashes against the original manifest.
8. Verify original public NIfTI and collection URLs no longer work. Public MRI viewers should use the separate display derivatives.

`DOWNLOAD_LIMITER` allows 20 POST attempts per 60 seconds per client IP, shared across filenames. Wrong, missing and correct passwords all count. The configured namespace must be unused by unrelated limiters in this account. Cloudflare's counters are per location and eventually consistent; this mitigates abuse rather than imposing a strict global attempt total. Missing or failed limiter bindings deny access.

## Local checks

`npm test` runs dependency-free Node integration tests with generated asset streams and a fake limiter. They cover all twelve files, ZIP order and bytes, password rejection, strict routes/CORS, cache headers, rate limiting, missing bindings, missing parts, body-length errors, cancellation and deployment configuration. The fixture password is unrelated to the deployed secret.

`npm run check` bundles without deployment. The `nodejs_compat` flag is required for native timing-safe comparison; `enable_request_signal` enables cleanup when the client disconnects. Local full-stack browser QA can explicitly override `ALLOWED_ORIGIN` with `http://127.0.0.1:8765` or `http://localhost:8765`. Production continues to accept only the configured GitHub HTTPS origin. If needed, inject `CF-Connecting-IP` in a test-only local proxy; never add a production fallback.

## Publication limits

Public display derivatives remain accessible so visitors can explore the MRI without a password. This protects the original download service, not the visible anatomy or meshes. Copies made before protection cannot be revoked. Previously public Git history must be separately removed from public access; deploying this Worker alone does not protect that history.

Documentation: [Worker-first asset routing](https://developers.cloudflare.com/workers/static-assets/routing/worker-script/), [asset binding](https://developers.cloudflare.com/workers/static-assets/binding/), [Worker secrets](https://developers.cloudflare.com/workers/configuration/secrets/), [rate limiter](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/), [stream Content-Length](https://developers.cloudflare.com/workers/runtime-apis/response/#set-the-content-length-header).
