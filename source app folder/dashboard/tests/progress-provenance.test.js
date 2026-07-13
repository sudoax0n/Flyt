import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createFlytServer } from '../server.js';
import {
  appendStageLog,
  createLineBuffer,
  parseProcessedFramesLine,
} from '../server-utils.js';

function abortError() {
  const error = new Error('aborted');
  error.name = 'AbortError';
  return error;
}

function createGate() {
  let resolveGate;
  let rejectGate;
  const promise = new Promise((resolve, reject) => {
    resolveGate = resolve;
    rejectGate = reject;
  });
  return {
    wait(signal) {
      if (signal.aborted) return Promise.reject(abortError());
      signal.addEventListener('abort', () => rejectGate(abortError()), { once: true });
      return promise;
    },
    resolve(value) { resolveGate(value); },
  };
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
    ...overrides,
  };
}

async function createHarness(services) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flyt-prov-'));
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
      try { await instance.stop(); } catch { /* cleanup */ }
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

async function waitForStatus(baseUrl, expected, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const response = await fetch(`${baseUrl}/api/status`);
    const status = await response.json();
    if (status.status === expected) return status;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${expected}`);
}

test('split stdout progress records reconstruct and update frames via line buffer', () => {
  let framesProcessed = 0;
  const lines = [];
  const buffer = createLineBuffer((line) => {
    lines.push(line);
    const frames = parseProcessedFramesLine(line);
    if (frames !== null) framesProcessed = frames;
  });
  // Deliberately split mid-token like Node stream chunks.
  buffer.push('Proce');
  buffer.push('ssed 100 fr');
  buffer.push('ames...\nProcesse');
  buffer.push('d 200 frames...\n');
  assert.deepEqual(lines, ['Processed 100 frames...', 'Processed 200 frames...']);
  assert.equal(framesProcessed, 200);
});

test('stage log is bounded, timestamped, and ignores aborted-context updates', () => {
  const log = [];
  appendStageLog(log, { stage: 'accepted', message: 'upload ok' }, {
    isCurrent: () => true,
    now: () => Date.parse('2026-07-13T10:00:00.000Z'),
  });
  assert.equal(log[0].t, '2026-07-13T10:00:00.000Z');
  for (let i = 0; i < 10; i += 1) {
    appendStageLog(log, {
      stage: 'tracker_progress',
      message: `Processed ${i * 100}`,
      frames: i * 100,
    }, { isCurrent: () => true });
  }
  assert.equal(log.filter((e) => e.stage === 'tracker_progress').length, 1);
  assert.equal(appendStageLog(log, { stage: 'completed', message: 'stale' }, {
    isCurrent: () => false,
  }), false);
  assert.equal(log.some((e) => e.stage === 'completed'), false);
});

test('successful run status and persisted metadata include provenance and integrity', async (t) => {
  const harness = await createHarness(standardServices());
  t.after(() => harness.close());

  assert.equal((await upload(harness.baseUrl, 'assay-a.mp4')).status, 200);
  const status = await waitForStatus(harness.baseUrl, 'done');

  assert.match(status.runId, /^run-/);
  assert.equal(status.uploadedFilename, 'assay-a.mp4');
  assert.equal(status.resultPublished, true);
  assert.equal(status.totalFrames, 4);
  assert.equal(status.framesProcessed, 4);
  assert.ok(Array.isArray(status.stageLog));
  assert.ok(status.stageLog.some((e) => e.stage === 'accepted'));
  assert.ok(status.stageLog.some((e) => e.stage === 'completed' || e.stage === 'publishing'));
  assert.ok(status.stageLog.every((e) => typeof e.t === 'string' && e.t.includes('T')));
  assert.equal(status.integrity?.passed, true);
  assert.equal(status.integrity?.inputFrames, 4);
  assert.equal(status.trackingValidity?.available, true);
  assert.equal(status.trackingValidity?.validFrames, 4);
  assert.ok(Number.isFinite(status.durationMs));

  const metadata = JSON.parse(fs.readFileSync(path.join(harness.paths.publicDir, 'run_metadata.json'), 'utf8'));
  assert.equal(metadata.runId, status.runId);
  assert.equal(metadata.filename, 'assay-a.mp4');
  assert.equal(metadata.frameIntegrity?.passed, true);
  assert.equal(metadata.trackingValidity?.validFrames, 4);
  assert.ok(Array.isArray(metadata.stageLog));

  const historyMeta = path.join(harness.paths.historyDir, status.runId, 'run_metadata.json');
  assert.equal(fs.existsSync(historyMeta), true);
  const historyIndex = JSON.parse(fs.readFileSync(harness.paths.historyMetaPath, 'utf8'));
  const entry = historyIndex.runs.find((run) => run.runId === status.runId);
  assert.equal(entry.filename, 'assay-a.mp4');
  assert.equal(entry.frameIntegrity?.passed, true);
});

test('failure preserves old public bundle and reports no new result published', async (t) => {
  let countCall = 0;
  const harness = await createHarness(standardServices({
    countFrames: async () => {
      countCall += 1;
      return countCall === 3 ? 3 : 4;
    },
  }));
  t.after(() => harness.close());

  fs.writeFileSync(path.join(harness.paths.publicDir, 'data.csv'), 'old-data');
  fs.writeFileSync(path.join(harness.paths.publicDir, 'tracked.mp4'), 'old-video');
  fs.writeFileSync(
    path.join(harness.paths.publicDir, 'run_metadata.json'),
    JSON.stringify({ runId: 'run-previous', filename: 'old.mp4' }),
  );

  assert.equal((await upload(harness.baseUrl, 'broken.mp4')).status, 200);
  const status = await waitForStatus(harness.baseUrl, 'error');

  assert.equal(status.resultPublished, false);
  assert.equal(status.uploadedFilename, 'broken.mp4');
  assert.match(status.error, /No new result was published/i);
  assert.match(status.error, /Frame integrity mismatch|integrity/i);
  assert.ok(Array.isArray(status.stageLog));
  assert.ok(status.stageLog.some((e) => e.stage === 'failed'));
  assert.doesNotMatch(status.error, /E:|\\\\uploads|\/tmp\//);

  assert.equal(fs.readFileSync(path.join(harness.paths.publicDir, 'data.csv'), 'utf8'), 'old-data');
  assert.equal(fs.readFileSync(path.join(harness.paths.publicDir, 'tracked.mp4'), 'utf8'), 'old-video');
  const priorMeta = JSON.parse(fs.readFileSync(path.join(harness.paths.publicDir, 'run_metadata.json'), 'utf8'));
  assert.equal(priorMeta.runId, 'run-previous');
  // Failed attempt must not rewrite provenance of the prior published run.
  assert.notEqual(status.runId, priorMeta.runId);
});

test('stale aborted run does not append success stages after reset', async (t) => {
  const gate = createGate();
  let trackerStarted = false;
  const harness = await createHarness(standardServices({
    countFrames: (_path, context) => gate.wait(context.controller.signal),
    runTracker: async () => {
      trackerStarted = true;
      return { code: 0, stdout: '', stderr: '' };
    },
  }));
  t.after(() => harness.close());

  assert.equal((await upload(harness.baseUrl, 'cancel-me.mp4')).status, 200);
  await new Promise((resolve) => setTimeout(resolve, 20));
  const mid = await (await fetch(`${harness.baseUrl}/api/status`)).json();
  assert.ok(mid.stageLog?.some((e) => e.stage === 'accepted' || e.stage === 'count_input'));

  const reset = await fetch(`${harness.baseUrl}/api/reset`, { method: 'POST' });
  assert.equal(reset.status, 200);
  gate.resolve(4);
  await new Promise((resolve) => setTimeout(resolve, 40));

  const after = await (await fetch(`${harness.baseUrl}/api/status`)).json();
  assert.notEqual(after.status, 'done');
  assert.equal(trackerStarted, false);
  if (Array.isArray(after.stageLog)) {
    assert.equal(after.stageLog.some((e) => e.stage === 'completed'), false);
  }
});
