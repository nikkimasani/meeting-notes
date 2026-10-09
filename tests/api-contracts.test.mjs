import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('transcription uploads are bounded and return request references', async () => {
  const source = await read('api/transcribe.js');
  assert.match(source, /24 \* 1024 \* 1024/);
  assert.match(source, /x-transcription-request-id/);
  assert.match(source, /AbortSignal\.timeout\(60000\)/);
});

test('background worker requires a server-side bearer secret', async () => {
  const source = await read('api/transcription-jobs/process.js');
  assert.match(source, /process\.env\.CRON_SECRET/);
  assert.match(source, /authorization === `Bearer \$\{expected\}`/);
  assert.doesNotMatch(source, /VITE_.*SERVICE_ROLE/);
});

test('job creation validates ownership and chunk limits', async () => {
  const source = await read('api/transcription-jobs/create.js');
  assert.match(source, /requireUser\(request\)/);
  assert.match(source, /chunks\.length > 240/);
  assert.match(source, /startsWith\(`\$\{user\.id\}\//);
});

test('recordings use continuous checkpoints and durable manifests', async () => {
  const app = await read('src/main.tsx');
  const store = await read('src/recording-store.ts');
  assert.match(app, /mr\.start\(5000\)/);
  assert.match(app, /appendRecordingChunk\(id,sequence,e\.data,duration\)/);
  assert.match(store, /backupStatus/);
  assert.match(store, /updatedAt/);
});
