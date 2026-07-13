import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  assertEventBelongsToRun,
  buildTrackerArgs,
  parseTrackerSync,
  prepareRunHistoryBundle,
  publishBundle,
  readCsvAvgProximity,
  recoverPublishArtifacts,
  recoverRuntimeArtifacts,
  resolveVerificationPath,
  runCommand,
  scopeEventsForRun,
  SimulatedProcessCrash,
  terminateChild,
  validateFrameIntegrity,
  verificationPathForRun,
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
  const diagnosticMismatch = validateFrameIntegrity({
    ...evidence,
    syncInfo: { ...evidence.syncInfo, expectedVideoFrames: 11 },
  });
  assert.equal(diagnosticMismatch.syncOk, true);
  assert.equal(diagnosticMismatch.expectedMetadataMatches, false);
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

test('crash recovery rolls back the entire partially published bundle', () => {
  const dir = tempDir('flyt-crash-rollback-');
  const sourceA = path.join(dir, 'source-a');
  const sourceB = path.join(dir, 'source-b');
  const destinationA = path.join(dir, 'a');
  const destinationB = path.join(dir, 'b');
  fs.writeFileSync(sourceA, 'new-a');
  fs.writeFileSync(sourceB, 'new-b');
  fs.writeFileSync(destinationA, 'old-a');
  fs.writeFileSync(destinationB, 'old-b');

  assert.throws(() => publishBundle([
    { source: sourceA, destination: destinationA },
    { source: sourceB, destination: destinationB },
  ], 'crash-token', {
    manifestDir: dir,
    faultInjector(stage, index) {
      if (stage === 'published' && index === 0) throw new SimulatedProcessCrash();
    },
  }), SimulatedProcessCrash);

  assert.equal(fs.readFileSync(destinationA, 'utf8'), 'new-a');
  assert.equal(fs.existsSync(destinationB), false);
  recoverPublishArtifacts(dir);
  assert.equal(fs.readFileSync(destinationA, 'utf8'), 'old-a');
  assert.equal(fs.readFileSync(destinationB, 'utf8'), 'old-b');
  assert.equal(fs.readdirSync(dir).some((name) => /flyt-publish|\.(bak|new)$/.test(name)), false);
});

test('crash recovery finalizes an explicitly committed all-new bundle', () => {
  const dir = tempDir('flyt-crash-commit-');
  const source = path.join(dir, 'source');
  const destination = path.join(dir, 'destination');
  fs.writeFileSync(source, 'new');
  fs.writeFileSync(destination, 'old');

  assert.throws(() => publishBundle([
    { source, destination },
  ], 'commit-token', {
    manifestDir: dir,
    faultInjector(stage) {
      if (stage === 'committed') throw new SimulatedProcessCrash();
    },
  }), SimulatedProcessCrash);

  recoverPublishArtifacts(dir);
  assert.equal(fs.readFileSync(destination, 'utf8'), 'new');
  assert.equal(fs.readdirSync(dir).some((name) => /flyt-publish|\.(bak|new)$/.test(name)), false);
});

test('legacy orphan backups fail closed instead of reconstructing a mixed bundle', () => {
  const dir = tempDir('flyt-orphan-backup-');
  const backup = path.join(dir, 'data.csv.token.bak');
  fs.writeFileSync(backup, 'old-data');
  assert.throws(() => recoverPublishArtifacts(dir), /without a transaction manifest/);
  assert.equal(fs.readFileSync(backup, 'utf8'), 'old-data');
});

test('history bundle uses scoped events and excludes invalid proximity observations', () => {
  const dir = tempDir('flyt-history-');
  const historyDir = path.join(dir, 'history');
  const historyMetaPath = path.join(dir, 'history.json');
  const historyIndexOutput = path.join(dir, 'next-history.json');
  const csv = path.join(dir, 'data.csv');
  const events = path.join(dir, 'events.json');
  const verification = path.join(dir, 'verification.json');
  const runId = 'run-1234-abcd';
  fs.writeFileSync(csv, [
    'frame,proximity_distance,occlusion_flag,tracking_valid,detection_count',
    '0,10,0,1,2',
    '1,10,0,0,0',
    '2,,1,0,1',
    '3,30,0,1,2',
  ].join('\n'));
  fs.writeFileSync(events, JSON.stringify({
    events: [{ id: 'evt-001', type: 'courtship_bout' }],
  }));
  fs.writeFileSync(verification, JSON.stringify({ version: 1, run_id: runId, reviews: [] }));
  scopeEventsForRun(events, runId, events);

  const bundle = prepareRunHistoryBundle({
    runId,
    historyDir,
    historyMetaPath,
    historyIndexOutput,
    filename: 'flies.mp4',
    durationSec: 2.3,
    fps: 30,
    totalFrames: 4,
    csvSrc: csv,
    eventsSrc: events,
    verificationSrc: verification,
  });
  assert.equal(bundle.meta.avgProximity, 20);
  assert.equal(bundle.meta.detectedBouts, 1);
  assert.equal(readCsvAvgProximity(csv), 20);
  publishBundle(bundle.entries, 'history-token', { manifestDir: dir });

  const scopedEvents = JSON.parse(fs.readFileSync(path.join(historyDir, runId, 'events.json')));
  assert.equal(scopedEvents.events[0].id, `${runId}:evt-001`);
  assert.equal(
    resolveVerificationPath(`${runId}:evt-001`, historyDir),
    path.join(historyDir, runId, 'verification.json'),
  );
  assert.equal(verificationPathForRun(runId, historyDir), path.join(historyDir, runId, 'verification.json'));
  assert.equal(assertEventBelongsToRun(`${runId}:evt-001`, historyDir), runId);
  assert.throws(
    () => assertEventBelongsToRun(`${runId}:evt-does-not-exist`, historyDir),
    /does not belong/,
  );
  assert.throws(() => resolveVerificationPath('evt-001', historyDir), /Run-scoped event ID required/);
});

test('rollback remains fail-closed when a new destination cannot be deleted', () => {
  const dir = tempDir('flyt-delete-failure-');
  const source = path.join(dir, 'source');
  const destination = path.join(dir, 'new-destination');
  const manifestPath = path.join(dir, '.flyt-publish-delete-failure.json');
  fs.writeFileSync(source, 'new-data');
  let blockDestinationRemoval = true;
  const removeFile = (filePath) => {
    if (blockDestinationRemoval && filePath === destination) {
      throw new Error('injected deletion failure');
    }
    fs.rmSync(filePath, { force: true });
    if (fs.existsSync(filePath)) throw new Error(`still exists: ${filePath}`);
  };

  assert.throws(() => publishBundle([
    { source, destination },
  ], 'delete-failure', {
    manifestDir: dir,
    removeFile,
    faultInjector(stage) {
      if (stage === 'published') throw new Error('injected publish failure');
    },
  }), /rollback was incomplete/);
  assert.equal(fs.readFileSync(destination, 'utf8'), 'new-data');
  assert.equal(fs.existsSync(manifestPath), true);

  blockDestinationRemoval = false;
  recoverPublishArtifacts(dir);
  assert.equal(fs.existsSync(destination), false);
  assert.equal(fs.existsSync(manifestPath), false);
});

test('startup runtime recovery removes abandoned inputs and run workspaces only', () => {
  const dir = tempDir('flyt-runtime-recovery-');
  fs.writeFileSync(path.join(dir, 'input-stale.mp4'), 'partial');
  fs.mkdirSync(path.join(dir, 'run-stale'));
  fs.writeFileSync(path.join(dir, 'run-stale', 'data.tmp'), 'partial');
  fs.writeFileSync(path.join(dir, 'keep.txt'), 'keep');

  recoverRuntimeArtifacts(dir);
  assert.equal(fs.existsSync(path.join(dir, 'input-stale.mp4')), false);
  assert.equal(fs.existsSync(path.join(dir, 'run-stale')), false);
  assert.equal(fs.readFileSync(path.join(dir, 'keep.txt'), 'utf8'), 'keep');
});

test('termination error without close rejects and never proves process exit', async () => {
  class ErrorOnlyChild extends EventEmitter {
    constructor() {
      super();
      this.exitCode = null;
      this.signalCode = null;
    }
    kill() {
      setTimeout(() => this.emit('error', new Error('signal delivery failed')), 1);
      return true;
    }
  }
  const child = new ErrorOnlyChild();
  await assert.rejects(
    terminateChild(child, { graceMs: 20, hardKillMs: 20 }),
    /termination failed before close/,
  );
  assert.equal(child.exitCode, null);
  assert.equal(child.signalCode, null);
});

test('runCommand keeps an unclosed child tracked after termination failure', async () => {
  class ErrorOnlyChild extends EventEmitter {
    constructor() {
      super();
      this.exitCode = null;
      this.signalCode = null;
      this.pid = 123;
    }
    kill() {
      setTimeout(() => this.emit('error', new Error('kill failed')), 1);
      return true;
    }
  }
  const child = new ErrorOnlyChild();
  const controller = new AbortController();
  const children = new Set();
  const command = runCommand('fake', [], {
    spawnFn: () => child,
    signal: controller.signal,
    children,
    killOptions: { graceMs: 20, hardKillMs: 20 },
  });
  controller.abort();
  await assert.rejects(command, /termination failed before close/);
  assert.equal(children.has(child), true);
  child.exitCode = 1;
  child.emit('close', 1, null);
  assert.equal(children.size, 0);
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

test('abort kills a real child process that ignores SIGTERM', async () => {
  const controller = new AbortController();
  const children = new Set();
  const command = runCommand(process.execPath, [
    '-e',
    "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);",
  ], {
    signal: controller.signal,
    children,
    killOptions: { graceMs: 20, hardKillMs: 500 },
  });

  const deadline = Date.now() + 1000;
  while (children.size === 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(children.size, 1);
  controller.abort();
  await assert.rejects(command, (error) => error?.name === 'AbortError');
  assert.equal(children.size, 0);
});
