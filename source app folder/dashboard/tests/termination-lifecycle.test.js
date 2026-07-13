import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createFlytServer } from '../server.js';

function abortError() {
  const error = new Error('aborted');
  error.name = 'AbortError';
  return error;
}

function writeTrackerOutputs(outputs, frames = 4) {
  fs.writeFileSync(outputs.rawVideo, 'raw-video');
  fs.writeFileSync(outputs.csv, [
    'frame,proximity_distance,occlusion_flag,tracking_valid,detection_count,fly1_area,fly2_area',
    ...Array.from({ length: frames }, (_, index) => `${index},20,0,1,2,100,100`),
  ].join('\n'));
  fs.writeFileSync(outputs.events, JSON.stringify({
    fps: 30,
    total_frames: frames,
    events: [{ id: 'evt-001', type: 'courtship_bout' }],
  }));
}

async function createHarness(services) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flyt-stop-lifecycle-'));
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
    killOptions: { graceMs: 10, hardKillMs: 20 },
    services,
  });
  const listener = await new Promise((resolve) => {
    const server = instance.app.listen(0, '127.0.0.1', () => resolve(server));
  });
  const address = listener.address();
  return {
    ...instance,
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

async function waitFor(check, timeoutMs = 1500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for lifecycle state');
}

async function waitForStatus(baseUrl, expected, timeoutMs = 1500) {
  return waitFor(async () => {
    const response = await fetch(`${baseUrl}/api/status`);
    const status = await response.json();
    return status.status === expected ? status : null;
  }, timeoutMs);
}

class InitiallyUnkillableChild extends EventEmitter {
  constructor() {
    super();
    this.exitCode = null;
    this.signalCode = null;
    this.pid = 123;
  }

  kill() {
    setTimeout(() => this.emit('error', new Error('signal delivery failed')), 1);
    return true;
  }

  closeLater() {
    this.exitCode = 1;
    this.emit('close', 1, null);
  }
}

test('late child close clears a failed stopping context and reopens uploads', async (t) => {
  let child;
  let countCalls = 0;
  const services = {
    countFrames: async (_filePath, context) => {
      countCalls += 1;
      if (countCalls > 1) return 4;

      child = new InitiallyUnkillableChild();
      context.children.add(child);
      return new Promise((_resolve, reject) => {
        child.once('close', () => {
          context.children.delete(child);
          reject(abortError());
        });
      });
    },
    runTracker: async (_input, outputs) => {
      writeTrackerOutputs(outputs);
      return {
        code: 0,
        stderr: '',
        stdout: 'TRACKER_SYNC frames_processed=4 csv_rows=4 expected_video_frames=4 sync_ok=true',
      };
    },
    transcode: async (raw, final) => fs.copyFileSync(raw, final),
  };
  const harness = await createHarness(services);
  t.after(() => harness.close());

  assert.equal((await upload(harness.baseUrl, 'first.mp4')).status, 200);
  await waitFor(() => child && harness.getState().activeRun?.children.has(child));

  const firstReset = await fetch(`${harness.baseUrl}/api/reset`, { method: 'POST' });
  assert.equal(firstReset.status, 500);
  assert.equal(harness.getState().terminating, true);
  assert.ok(harness.getState().stoppingRun);
  assert.equal((await upload(harness.baseUrl, 'blocked.mp4')).status, 409);

  const secondReset = await fetch(`${harness.baseUrl}/api/reset`, { method: 'POST' });
  assert.equal(secondReset.status, 500);
  assert.equal(harness.getState().terminating, true);
  assert.ok(harness.getState().stoppingRun?.children.has(child));

  child.closeLater();
  await waitFor(() => {
    const state = harness.getState();
    return !state.terminating && state.stoppingRun === null && state.job.status === 'idle';
  });

  assert.equal((await upload(harness.baseUrl, 'after-close.mp4')).status, 200);
  await waitForStatus(harness.baseUrl, 'done');
});
