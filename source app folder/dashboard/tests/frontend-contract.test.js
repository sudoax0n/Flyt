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
