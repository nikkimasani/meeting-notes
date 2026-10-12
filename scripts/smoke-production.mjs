import assert from 'node:assert/strict';

const appUrl = process.env.APP_URL || 'https://meeting-notes-eta-ecru.vercel.app';
const cloudflareUrl = process.env.CLOUDFLARE_URL || 'https://meeting-notes-cloudflare.pages.dev';

const app = await fetch(appUrl);
assert.equal(app.status, 200, `Vercel app returned ${app.status}`);
assert.match(await app.text(), /<div id="root"><\/div>/);

const cloudflare = await fetch(cloudflareUrl);
assert.equal(cloudflare.status, 200, `Cloudflare app returned ${cloudflare.status}`);

const cors = await fetch(`${appUrl}/api/transcribe`, {
  method: 'OPTIONS',
  headers: { origin: cloudflareUrl },
});
assert.equal(cors.status, 204);
assert.equal(cors.headers.get('access-control-allow-origin'), cloudflareUrl);

const worker = await fetch(`${appUrl}/api/transcription-jobs/process`);
assert.equal(worker.status, 401, 'Background worker must reject unauthenticated requests');

console.log('Production smoke checks passed.');
