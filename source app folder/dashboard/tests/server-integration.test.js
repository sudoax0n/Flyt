import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createFlytServer } from '../server.js';

function abortError() {
  const error = new Error('aborted');
  error.name = 'AbortError';
  return error;
}

function createGate({ releaseOnAbort = true } = {}) {
  let resolveGate;
  let rejectGate;
  let aborted = false;
  const promise = new Promise((resolve, reject) => {
    resolveGate = resolve;
    rejectGate = reject;
  });
  return {
    wait(signal) {
      if (signal.aborted) return Promise.reject(abortError());
      signal.addEventListener('abort', () => {
        aborted = true;
        if (releaseOnAbort) rejectGate(abortError());
      }, { once: true });
      return promise;
    },
    resolve(value) { resolveGate(value); },
    reject(error) { rejectGate(error); },
    get aborted() { return aborted; },
  };
}

function writeTrackerOutputs(outputs, frames = 4) {
  fs.writeFileSync(outputs.rawVideo, 'raw-video');
  fs.writeFileSync(outputs.csv, [
    'frame,proximity_distance,occlusion_flag',
    ...Array.from({ length: frames }, (_, index) => `${index},20,0`),
  ].join('\n'));
  fs.writeFileSync(outputs.events, JSON.stringify({
    fps: 30,
    total_frames: frames,
    events: [{ id: 'evt-001', type: 'courtship_bout' }],
  }));
}

function standardServices(overrides = {}) {
  return {
    countFrames: async () => 4,
    runTracker: async (_input, outputs) => {
      writeTrackerOutputs(outputs);
      return {
        code: 0,
        stderr: '',
        stdout: 'TRACKER_SYNC frames_processed=4 csv_rows=4 expected_video_frames=4 sync_ok=true',
      };
    },
    transcode: async (raw, final) => fs.copyFileSync(raw, final),
    snapshot: () => null,
    ...overrides,
  };
}

async function createHarness(services) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flyt-http-'));
  const instance = createFlytServer({
    rootDir: root,
    uploadsDir: path.join(root, 'uploads'),
    publicDir: path.join(root, 'public'),
    historyDir: path.join(root, 'public', 'history'),
    historyMetaPath: path.join(root, 'public', 'history.json'),
    verificationPath: path.join(root, 'public', 'verification.json'),
    trackerDir: path.join(root, 'tracker'),
    trackerScript: path.join(root, 'tracker', 'tracker.py'),
    pythonExe: 'python',
    ffmpegPath: 'ffmpeg',
    allowedOrigins: ['http://localhost:5173'],
    services,
  });
  const listener = await new Promise((resolve) => {
    const server = instance.app.listen(0, '127.0.0.1', () => resolve(server));
  });
  const address = listener.address();
  return {
    ...instance,
    root,
    baseUrl: `http://127.0.0.1:${address.port}`,
    async close() {
      try { await instance.stop(); } catch { /* test cleanup */ }
      await new Promise((resolve) => listener.close(resolve));
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

async function upload(baseUrl, name = 'flies.mp4') {
  const form = new FormData();
  form.append('video', new Blob(['video-bytes'], { type: 'video/mp4' }), name);
  return fetch(`${baseUrl}/api/upload`, { method: 'POST', body: form });
}

async function waitForStatus(baseUrl, expected, timeoutMs = 1500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const response = await fetch(`${baseUrl}/api/status`);
    const status = await response.json();
    if (status.status === expected) return status;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${expected}`);
}

test('rejects a simultaneous upload before a second file is accepted', async (t) => {
  const gate = createGate();
  const harness = await createHarness(standardServices({
    countFrames: (_path, context) => gate.wait(context.controller.signal),
  }));
  t.after(() => harness.close());

  assert.equal((await upload(harness.baseUrl, 'first.mp4')).status, 200);
  assert.equal((await upload(harness.baseUrl, 'second.mp4')).status, 409);
  assert.equal(fs.readdirSync(harness.paths.uploadsDir).filter((name) => name.startsWith('input-')).length, 1);

  const reset = await fetch(`${harness.baseUrl}/api/reset`, { method: 'POST' });
  assert.equal(reset.status, 200);
  assert.equal(gate.aborted, true);
});

test('reset during a multipart upload invalidates and removes the partial upload', async (t) => {
  const harness = await createHarness(standardServices());
  t.after(() => harness.close());
  const boundary = '----flyt-boundary';
  const prefix = [
    `--${boundary}`,
    'Content-Disposition: form-data; name="video"; filename="slow.mp4"',
    'Content-Type: video/mp4',
    '',
    'partial-video-',
  ].join('\r\n');
  const suffix = `\r\n--${boundary}--\r\n`;

  let finishUpload;
  const uploadResponse = new Promise((resolve, reject) => {
    const request = http.request(`${harness.baseUrl}/api/upload`, {
      method: 'POST',
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
    }, (response) => {
      response.resume();
      response.on('end', () => resolve(response));
    });
    request.on('error', reject);
    request.write(prefix);
    finishUpload = () => request.end(`remaining${suffix}`);
  });

  await new Promise((resolve) => setTimeout(resolve, 30));
  const reset = await fetch(`${harness.baseUrl}/api/reset`, { method: 'POST' });
  assert.equal(reset.status, 200);
  finishUpload();
  const response = await uploadResponse;
  assert.equal(response.statusCode, 409);
  assert.equal(
    fs.readdirSync(harness.paths.uploadsDir).filter((name) => name.startsWith('input-')).length,
    0,
  );
});

test('reset remains pending until the active stage has actually stopped', async (t) => {
  const gate = createGate({ releaseOnAbort: false });
  const harness = await createHarness(standardServices({
    countFrames: (_path, context) => gate.wait(context.controller.signal),
  }));
  t.after(() => harness.close());

  assert.equal((await upload(harness.baseUrl)).status, 200);
  let resetSettled = false;
  const resetPromise = fetch(`${harness.baseUrl}/api/reset`, { method: 'POST' })
    .then((response) => { resetSettled = true; return response; });
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(resetSettled, false);
  assert.equal((await upload(harness.baseUrl, 'blocked.mp4')).status, 409);

  gate.resolve(4);
  assert.equal((await resetPromise).status, 200);
  assert.equal(resetSettled, true);
});

test('reset during transcoding prevents stale publication', async (t) => {
  const transcodeGate = createGate({ releaseOnAbort: false });
  let publishCalls = 0;
  const harness = await createHarness(standardServices({
    transcode: async (raw, final, context) => {
      await transcodeGate.wait(context.controller.signal);
      fs.copyFileSync(raw, final);
    },
    publish: () => { publishCalls += 1; },
  }));
  t.after(() => harness.close());

  assert.equal((await upload(harness.baseUrl)).status, 200);
  await new Promise((resolve) => setTimeout(resolve, 30));
  const resetPromise = fetch(`${harness.baseUrl}/api/reset`, { method: 'POST' });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(transcodeGate.aborted, true);
  assert.equal(publishCalls, 0);

  transcodeGate.resolve();
  assert.equal((await resetPromise).status, 200);
  assert.equal(publishCalls, 0);
});

test('a complete run publishes only after every frame count agrees', async (t) => {
  const harness = await createHarness(standardServices());
  t.after(() => harness.close());

  assert.equal((await upload(harness.baseUrl)).status, 200);
  const status = await waitForStatus(harness.baseUrl, 'done');
  assert.equal(status.frameCount, 4);
  const metadata = JSON.parse(fs.readFileSync(path.join(harness.paths.publicDir, 'run_metadata.json')));
  assert.equal(metadata.inputFrames, 4);
  assert.equal(metadata.rawVideoFrames, 4);
  assert.equal(metadata.finalVideoFrames, 4);
  assert.equal(metadata.syncOk, true);
});

test('frame mismatch fails closed and preserves the previous published bundle', async (t) => {
  let countCall = 0;
  const harness = await createHarness(standardServices({
    countFrames: async () => {
      countCall += 1;
      return countCall === 3 ? 3 : 4;
    },
  }));
  t.after(() => harness.close());
  fs.writeFileSync(path.join(harness.paths.publicDir, 'data.csv'), 'old-data');

  assert.equal((await upload(harness.baseUrl)).status, 200);
  const status = await waitForStatus(harness.baseUrl, 'error');
  assert.match(status.error, /Frame integrity mismatch/);
  assert.equal(fs.readFileSync(path.join(harness.paths.publicDir, 'data.csv'), 'utf8'), 'old-data');
});

test('destructive cross-origin requests are denied unless explicitly allowed', async (t) => {
  const harness = await createHarness(standardServices());
  t.after(() => harness.close());

  const denied = await fetch(`${harness.baseUrl}/api/reset`, {
    method: 'POST',
    headers: { Origin: 'https://evil.example' },
  });
  assert.equal(denied.status, 403);

  const allowed = await fetch(`${harness.baseUrl}/api/reset`, {
    method: 'POST',
    headers: { Origin: 'http://localhost:5173' },
  });
  assert.equal(allowed.status, 200);
  assert.equal(allowed.headers.get('access-control-allow-origin'), 'http://localhost:5173');
});
