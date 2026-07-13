import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  buildTrackerArgs,
  parseTrackerSync,
  publishBundle,
  recoverPublishArtifacts,
  resolveVerificationPath,
  scopeEventsForHistory,
  snapshotRunToHistory,
  terminateChild,
  validateFrameIntegrity,
} from '../server-utils.js';

const defaults = { minArea: 30, maxArea: 0, proximityThreshold: 60, boutMinFrames: 90 };
const tempDir = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

test('normalizes integer tracker settings and rejects invalid max area', () => {
  const args = buildTrackerArgs('tracker.py', 'in.mp4', {
    rawVideo: 'raw.mp4', csv: 'data.csv', events: 'events.json',
  }, { minArea: 30.9, maxArea: 20.2, boutMinFrames: 0.8 }, defaults);
  assert.equal(args[args.indexOf('--min-area') + 1], '30');
  assert.equal(args[args.indexOf('--max-area') + 1], '0');
  assert.equal(args[args.indexOf('--bout-min-frames') + 1], '1');
});

test('requires exactly one tracker sync marker', () => {
  const marker = 'TRACKER_SYNC frames_processed=12 csv_rows=12 expected_video_frames=12 sync_ok=true';
  assert.deepEqual(parseTrackerSync(marker), {
    framesProcessed: 12, csvRows: 12, expectedVideoFrames: 12, syncOk: true,
  });
  assert.equal(parseTrackerSync('no marker'), null);
  assert.equal(parseTrackerSync(`${marker}\n${marker}`), null);
});

test('frame validation fails closed on missing evidence or disagreement', () => {
  const evidence = {
    syncInfo: { framesProcessed: 12, csvRows: 12, expectedVideoFrames: 12, syncOk: true },
    inputFrames: 12, csvRows: 12, rawVideoFrames: 12, finalVideoFrames: 12,
  };
  assert.equal(validateFrameIntegrity(evidence).syncOk, true);
  assert.throws(() => validateFrameIntegrity({ ...evidence, syncInfo: null }), /marker required/);
  assert.throws(() => validateFrameIntegrity({ ...evidence, finalVideoFrames: 11 }), /mismatch/);
  assert.throws(() => validateFrameIntegrity({
    ...evidence,
    syncInfo: { ...evidence.syncInfo, expectedVideoFrames: 11 },
  }), /mismatch/);
});

test('publishes a complete bundle and removes backups', () => {
  const dir = tempDir('flyt-publish-');
  const sourceA = path.join(dir, 'source-a');
  const sourceB = path.join(dir, 'source-b');
  const destinationA = path.join(dir, 'a');
  const destinationB = path.join(dir, 'b');
  fs.writeFileSync(sourceA, 'new-a');
  fs.writeFileSync(sourceB, 'new-b');
  fs.writeFileSync(destinationA, 'old-a');
  fs.writeFileSync(destinationB, 'old-b');
  publishBundle([
    { source: sourceA, destination: destinationA },
    { source: sourceB, destination: destinationB },
  ], 'token');
  assert.equal(fs.readFileSync(destinationA, 'utf8'), 'new-a');
  assert.equal(fs.readFileSync(destinationB, 'utf8'), 'new-b');
  assert.equal(fs.readdirSync(dir).some((name) => /\.(bak|new)$/.test(name)), false);
});

test('rolls back after one destination has already been published', () => {
  const dir = tempDir('flyt-rollback-');
  const sources = ['new-a', 'new-b'].map((content, index) => {
    const file = path.join(dir, `source-${index}`);
    fs.writeFileSync(file, content);
    return file;
  });
  const destinations = [path.join(dir, 'a'), path.join(dir, 'b')];
  fs.writeFileSync(destinations[0], 'old-a');
  fs.writeFileSync(destinations[1], 'old-b');
  assert.throws(() => publishBundle([
    { source: sources[0], destination: destinations[0] },
    { source: sources[1], destination: destinations[1] },
  ], 'token', {
    faultInjector(stage, index) {
      if (stage === 'published' && index === 0) throw new Error('injected failure');
    },
  }), /injected failure/);
  assert.equal(fs.readFileSync(destinations[0], 'utf8'), 'old-a');
  assert.equal(fs.readFileSync(destinations[1], 'utf8'), 'old-b');
  assert.equal(fs.readdirSync(dir).some((name) => /\.(bak|new)$/.test(name)), false);
});

test('recovers orphaned publication artifacts after a crash', () => {
  const dir = tempDir('flyt-recover-');
  fs.writeFileSync(path.join(dir, 'data.csv.token.bak'), 'old-data');
  fs.writeFileSync(path.join(dir, 'events.json.token.new'), 'new-events');
  recoverPublishArtifacts(dir);
  assert.equal(fs.readFileSync(path.join(dir, 'data.csv'), 'utf8'), 'old-data');
  assert.equal(fs.existsSync(path.join(dir, 'events.json.token.new')), false);
});

test('history snapshots preserve dashboard summary fields and scoped reviews', () => {
  const dir = tempDir('flyt-history-');
  const historyDir = path.join(dir, 'history');
  const historyMetaPath = path.join(dir, 'history.json');
  const csv = path.join(dir, 'data.csv');
  const events = path.join(dir, 'events.json');
  fs.writeFileSync(csv, [
    'frame,proximity_distance,occlusion_flag', '0,10,0', '1,0,1', '2,30,0',
  ].join('\n'));
  fs.writeFileSync(events, JSON.stringify({
    events: [{ id: 'evt-001', type: 'courtship_bout' }],
  }));
  const meta = snapshotRunToHistory({
    historyDir, historyMetaPath, filename: 'flies.mp4', durationSec: 2.3,
    fps: 30, totalFrames: 3, csvSrc: csv, eventsSrc: events,
  });
  assert.equal(meta.avgProximity, 20);
  assert.equal(meta.detectedBouts, 1);
  const scopedEvents = JSON.parse(fs.readFileSync(path.join(historyDir, meta.runId, 'events.json')));
  assert.equal(scopedEvents.events[0].id, `${meta.runId}:evt-001`);
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(historyDir, meta.runId, 'verification.json'))),
    { version: 1, reviews: [] },
  );
});

test('scopes historical event IDs and verification paths to their run', () => {
  const dir = tempDir('flyt-history-path-');
  const historyDir = path.join(dir, 'history');
  const runId = 'run-1234-abcd';
  fs.mkdirSync(path.join(historyDir, runId), { recursive: true });
  const source = path.join(dir, 'events.json');
  const scoped = path.join(historyDir, runId, 'events.json');
  const historyMeta = path.join(dir, 'history.json');
  fs.writeFileSync(source, JSON.stringify({ events: [{ id: 'evt-001' }] }));
  fs.writeFileSync(historyMeta, JSON.stringify({ runs: [{ runId }] }));
  scopeEventsForHistory(source, runId, scoped);
  assert.equal(JSON.parse(fs.readFileSync(scoped)).events[0].id, `${runId}:evt-001`);
  assert.equal(
    resolveVerificationPath(`${runId}:evt-001`, 'current.json', historyDir, historyMeta),
    path.join(historyDir, runId, 'verification.json'),
  );
});

test('termination escalates to SIGKILL and resolves only after close', async () => {
  class FakeChild extends EventEmitter {
    constructor() {
      super();
      this.exitCode = null;
      this.signalCode = null;
      this.signals = [];
    }
    kill(signal) {
      this.signals.push(signal);
      if (signal === 'SIGKILL') {
        setTimeout(() => {
          this.signalCode = signal;
          this.emit('close', null, signal);
        }, 5);
      }
      return true;
    }
  }
  const child = new FakeChild();
  let settled = false;
  const termination = terminateChild(child, { graceMs: 5, hardKillMs: 100 })
    .then(() => { settled = true; });
  await new Promise((resolve) => setTimeout(resolve, 7));
  assert.equal(settled, false);
  await termination;
  assert.deepEqual(child.signals, ['SIGTERM', 'SIGKILL']);
});
