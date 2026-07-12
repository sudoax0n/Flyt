import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  buildTrackerArgs,
  parseTrackerSync,
  publishBundle,
  resolveVerificationPath,
  scopeEventsForHistory,
} from '../server-utils.js';

const defaults = { minArea: 30, maxArea: 0, proximityThreshold: 60, boutMinFrames: 90 };

test('normalizes integer tracker settings and rejects invalid max area', () => {
  const args = buildTrackerArgs('tracker.py', 'in.mp4', {
    rawVideo: 'raw.mp4', csv: 'data.csv', events: 'events.json',
  }, { minArea: 30.9, maxArea: 20.2, boutMinFrames: 0.8 }, defaults);
  assert.equal(args[args.indexOf('--min-area') + 1], '30');
  assert.equal(args[args.indexOf('--max-area') + 1], '0');
  assert.equal(args[args.indexOf('--bout-min-frames') + 1], '1');
});

test('parses tracker sync output', () => {
  assert.deepEqual(parseTrackerSync(
    'TRACKER_SYNC frames_processed=12 csv_rows=12 expected_video_frames=14 sync_ok=true',
  ), { framesProcessed: 12, csvRows: 12, expectedVideoFrames: 14, syncOk: true });
});

test('publishes a complete bundle and removes backups', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flyt-publish-'));
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
  assert.equal(fs.readdirSync(dir).some((name) => name.endsWith('.bak')), false);
});

test('rolls back every destination when bundle staging fails', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flyt-rollback-'));
  const source = path.join(dir, 'source');
  const missing = path.join(dir, 'missing');
  const destinationA = path.join(dir, 'a');
  const destinationB = path.join(dir, 'b');
  fs.writeFileSync(source, 'new-a');
  fs.writeFileSync(destinationA, 'old-a');
  fs.writeFileSync(destinationB, 'old-b');
  assert.throws(() => publishBundle([
    { source, destination: destinationA },
    { source: missing, destination: destinationB },
  ], 'token'));
  assert.equal(fs.readFileSync(destinationA, 'utf8'), 'old-a');
  assert.equal(fs.readFileSync(destinationB, 'utf8'), 'old-b');
});

test('scopes historical event IDs and verification paths to their run', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flyt-history-'));
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
