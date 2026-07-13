import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const appSource = () => fs.readFileSync(path.join(testDir, '..', 'src', 'App.jsx'), 'utf8');

test('historic runs load and count their scoped verification state', () => {
  const source = appSource();
  assert.match(source, /api\/verification\?runId=\$\{encodeURIComponent\(runId\)\}/);
  assert.doesNotMatch(source, /if \(!runId\) \{\s*try \{\s*const verRes/);
  assert.match(source, /const \{ detected, verified \} = computeCourtshipStats\(eventList, reviews\)/);
  assert.doesNotMatch(source, /verified:\s*0/);
});

test('historic runs display their recorded timestamp rather than load time', () => {
  const source = appSource();
  assert.match(source, /setRunTimestamp\(run\.timestamp \|\| null\)/);
  assert.match(source, /loadHistoricRun\(run\)/);
});


test('dashboard and Prism export use validity-aware proximity helpers', () => {
  const source = appSource();
  assert.match(source, /proximityValue\(row\)/);
  assert.match(source, /prismDistance\(r\)/);
  assert.doesNotMatch(source, /Number\(r\.proximity_distance \?\? 0\)/);
});

test('current video requires validated provenance and clears on new upload', () => {
  const source = appSource();
  assert.match(source, /videoAvailable && runProvenance\?\.runId/);
  assert.match(source, /clearCurrentResultDisplay/);
  assert.match(source, /loadAll\(Date\.now\(\), completedRunId\)/);
  assert.match(source, /No new result was published/);
  assert.match(source, /Tracking validity/);
  assert.match(source, /summarizeTrackingValidity/);
  // Must not unconditionally mount tracked.mp4 for non-historic data.
  assert.doesNotMatch(
    source,
    /isHistoricRun \? \([\s\S]*?\) : \(\s*<video[\s\S]*?src=\{`\/tracked\.mp4/,
  );
});

test('initial mount loads history only and does not load a previous run automatically', () => {
  const source = appSource();
  // Ensure we call loadHistory on mount, not loadAll.
  assert.match(source, /useEffect\(\(\) => \{\s*loadHistory\(\);/);
  assert.doesNotMatch(source, /useEffect\(\(\) => \{\s*loadAll\(\);/);
  // Check that DashboardView shows empty state when no run ID is loaded.
  assert.match(source, /!runProvenance\?\.runId/);
  assert.match(source, /No tracking run loaded/);
});

