import { randomUUID } from 'crypto';
import { spawn as nodeSpawn } from 'child_process';
import fs from 'fs';
import path from 'path';

export class AbortRunError extends Error {
  constructor(message = 'Run aborted') {
    super(message);
    this.name = 'AbortError';
  }
}

export function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

export function safeUnlink(filePath) {
  if (!filePath) return;
  try { fs.rmSync(filePath, { force: true }); } catch (error) {
    console.error(`[Server] Failed to remove ${filePath}: ${error.message}`);
  }
}

export function safeRemoveDir(dirPath) {
  if (!dirPath) return;
  try { fs.rmSync(dirPath, { recursive: true, force: true }); } catch (error) {
    console.error(`[Server] Failed to remove ${dirPath}: ${error.message}`);
  }
}

export function readJson(filePath, fallback) {
  if (!fs.existsSync(filePath)) return fallback;
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch { return fallback; }
}

export function writeJson(filePath, data) {
  ensureDir(path.dirname(filePath));
  const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(data, null, 2));
  fs.renameSync(tempPath, filePath);
}

export function countCsvRows(csvPath) {
  const content = fs.readFileSync(csvPath, 'utf8').trim();
  return content ? content.split(/\r?\n/).length - 1 : 0;
}

export function parseTrackerSync(stdout) {
  const matches = [...String(stdout).matchAll(
    /TRACKER_SYNC frames_processed=(\d+) csv_rows=(\d+) expected_video_frames=(\d+) sync_ok=(true|false)/g,
  )];
  if (matches.length !== 1) return null;
  const match = matches[0];
  return {
    framesProcessed: Number(match[1]),
    csvRows: Number(match[2]),
    expectedVideoFrames: Number(match[3]),
    syncOk: match[4] === 'true',
  };
}

function requirePositiveInteger(name, value) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`Frame integrity evidence missing or invalid: ${name}=${value}`);
  }
}

export function validateFrameIntegrity({
  syncInfo,
  inputFrames,
  csvRows,
  rawVideoFrames,
  finalVideoFrames,
}) {
  if (!syncInfo) throw new Error('Frame integrity evidence missing: TRACKER_SYNC marker required');
  if (syncInfo.syncOk !== true) throw new Error('Tracker reported frame synchronization failure');

  const counts = {
    inputFrames,
    trackerFrames: syncInfo.framesProcessed,
    trackerCsvRows: syncInfo.csvRows,
    csvRows,
    rawVideoFrames,
    finalVideoFrames,
  };
  Object.entries(counts).forEach(([name, value]) => requirePositiveInteger(name, value));

  if (!Number.isInteger(syncInfo.expectedVideoFrames) || syncInfo.expectedVideoFrames < 0) {
    throw new Error(
      `Frame integrity evidence missing or invalid: trackerExpectedFrames=${syncInfo.expectedVideoFrames}`,
    );
  }

  const unique = new Set(Object.values(counts));
  if (unique.size !== 1) {
    const detail = Object.entries(counts).map(([key, value]) => `${key}=${value}`).join(', ');
    throw new Error(`Frame integrity mismatch (${detail})`);
  }

  return {
    ...counts,
    trackerExpectedFrames: syncInfo.expectedVideoFrames,
    expectedMetadataMatches: (
      syncInfo.expectedVideoFrames === 0 || syncInfo.expectedVideoFrames === inputFrames
    ),
    syncOk: true,
  };
}

const terminationPromises = new WeakMap();

export function terminateChild(child, { graceMs = 1000, hardKillMs = 3000 } = {}) {
  if (!child || child.exitCode !== null || child.signalCode) return Promise.resolve();
  if (terminationPromises.has(child)) return terminationPromises.get(child);

  const promise = new Promise((resolve, reject) => {
    let settled = false;
    let graceTimer;
    let hardTimer;
    const cleanup = () => {
      clearTimeout(graceTimer);
      clearTimeout(hardTimer);
      child.removeListener('close', finish);
      child.removeListener('error', finish);
    };
    const finish = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    };
    const fail = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error('Child process did not terminate after SIGKILL'));
    };

    child.once('close', finish);
    child.once('error', finish);
    try { child.kill('SIGTERM'); } catch { finish(); return; }
    graceTimer = setTimeout(() => {
      if (settled) return;
      try { child.kill('SIGKILL'); } catch { finish(); return; }
      hardTimer = setTimeout(fail, hardKillMs);
      hardTimer.unref?.();
    }, graceMs);
    graceTimer.unref?.();
  }).finally(() => terminationPromises.delete(child));

  terminationPromises.set(child, promise);
  return promise;
}

export function runCommand(command, args, {
  spawnFn = nodeSpawn,
  signal,
  children,
  onStdout,
  onStderr,
  killOptions,
} = {}) {
  if (signal?.aborted) return Promise.reject(new AbortRunError());

  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnFn(command, args);
    } catch (error) {
      reject(error);
      return;
    }
    children?.add(child);
    let stdout = '';
    let stderr = '';
    let settled = false;

    const cleanup = () => {
      children?.delete(child);
      signal?.removeEventListener('abort', onAbort);
    };
    const settle = (handler, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      handler(value);
    };
    const onAbort = () => {
      terminateChild(child, killOptions)
        .then(() => settle(reject, new AbortRunError()))
        .catch((error) => settle(reject, error));
    };

    child.stdout?.on('data', (chunk) => {
      const text = chunk.toString();
      stdout += text;
      onStdout?.(text);
    });
    child.stderr?.on('data', (chunk) => {
      const text = chunk.toString();
      stderr += text;
      onStderr?.(text);
    });
    child.once('error', (error) => settle(reject, error));
    child.once('close', (code, closeSignal) => {
      if (signal?.aborted) settle(reject, new AbortRunError());
      else settle(resolve, { code, signal: closeSignal, stdout, stderr });
    });
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

export async function getVideoFrameCount(ffmpegPath, videoPath, options = {}) {
  const result = await runCommand(ffmpegPath, [
    '-hide_banner', '-i', videoPath, '-map', '0:v:0', '-f', 'null', '-',
  ], options);
  if (result.code !== 0) {
    throw new Error(`ffmpeg frame count failed (exit ${result.code}): ${result.stderr.slice(-500)}`);
  }
  const matches = [...result.stderr.matchAll(/frame=\s*(\d+)/g)];
  if (!matches.length) throw new Error(`Could not determine video frame count for ${videoPath}`);
  const count = Number(matches.at(-1)[1]);
  requirePositiveInteger('decodedVideoFrames', count);
  return count;
}

export async function transcodeVideo(ffmpegPath, rawPath, finalPath, options = {}) {
  const result = await runCommand(ffmpegPath, [
    '-hide_banner', '-i', rawPath, '-vcodec', 'libx264', '-preset', 'veryfast',
    '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-an', '-y', finalPath,
  ], options);
  if (result.code !== 0) {
    throw new Error(`ffmpeg transcode failed (exit ${result.code}): ${result.stderr.slice(-500)}`);
  }
}

export class SimulatedProcessCrash extends Error {
  constructor(message = 'Simulated process crash') {
    super(message);
    this.name = 'SimulatedProcessCrash';
  }
}

function validatePublishToken(token) {
  if (!/^[A-Za-z0-9-]+$/.test(String(token))) {
    throw new Error(`Invalid publication token: ${token}`);
  }
}

function publishManifestPath(entries, token, manifestDir) {
  if (!entries.length) throw new Error('Publication bundle is empty');
  validatePublishToken(token);
  const directory = manifestDir || path.dirname(entries[0].destination);
  ensureDir(directory);
  return path.join(directory, `.flyt-publish-${token}.json`);
}

function validatePublishManifest(manifest, manifestPath) {
  if (!manifest || manifest.version !== 1 || !Array.isArray(manifest.entries)) {
    throw new Error(`Invalid publication transaction manifest: ${manifestPath}`);
  }
  if (!['prepared', 'publishing', 'committed'].includes(manifest.state)) {
    throw new Error(`Invalid publication transaction state in ${manifestPath}`);
  }
  manifest.entries.forEach((entry) => {
    for (const key of ['destination', 'stage', 'backup']) {
      if (typeof entry[key] !== 'string' || !path.isAbsolute(entry[key])) {
        throw new Error(`Invalid ${key} in publication transaction ${manifestPath}`);
      }
    }
    if (typeof entry.hadDestination !== 'boolean') {
      throw new Error(`Invalid hadDestination in publication transaction ${manifestPath}`);
    }
  });
  return manifest;
}

function rollbackPublishManifest(manifest) {
  const errors = [];
  [...manifest.entries].reverse().forEach((entry) => {
    try {
      if (entry.hadDestination) {
        if (fs.existsSync(entry.backup)) {
          safeUnlink(entry.destination);
          ensureDir(path.dirname(entry.destination));
          fs.renameSync(entry.backup, entry.destination);
        } else if (!fs.existsSync(entry.destination)) {
          throw new Error(`Cannot restore missing prior destination: ${entry.destination}`);
        }
      } else {
        safeUnlink(entry.destination);
        safeUnlink(entry.backup);
      }
      safeUnlink(entry.stage);
    } catch (error) {
      errors.push(error);
    }
  });
  if (errors.length) {
    throw new globalThis.AggregateError(errors, 'Publication transaction rollback failed');
  }
}

function finalizeCommittedManifest(manifest) {
  const missing = manifest.entries.filter((entry) => !fs.existsSync(entry.destination));
  if (missing.length) {
    rollbackPublishManifest(manifest);
    return;
  }
  manifest.entries.forEach((entry) => {
    safeUnlink(entry.stage);
    safeUnlink(entry.backup);
  });
}

function listFilesRecursive(directory) {
  if (!fs.existsSync(directory)) return [];
  const files = [];
  fs.readdirSync(directory, { withFileTypes: true }).forEach((entry) => {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...listFilesRecursive(fullPath));
    else if (entry.isFile()) files.push(fullPath);
  });
  return files;
}

export function publishBundle(entries, token, { faultInjector, manifestDir } = {}) {
  const manifestPath = publishManifestPath(entries, token, manifestDir);
  const manifest = {
    version: 1,
    token,
    state: 'prepared',
    entries: entries.map(({ source, destination }) => ({
      source,
      destination: path.resolve(destination),
      stage: path.resolve(`${destination}.${token}.new`),
      backup: path.resolve(`${destination}.${token}.bak`),
      hadDestination: fs.existsSync(destination),
    })),
  };

  try {
    manifest.entries.forEach((entry) => {
      if (!fs.existsSync(entry.source)) throw new Error(`Missing publish source: ${entry.source}`);
      ensureDir(path.dirname(entry.destination));
      fs.copyFileSync(entry.source, entry.stage);
    });
    writeJson(manifestPath, manifest);
    faultInjector?.('prepared', -1);

    manifest.entries.forEach((entry, index) => {
      if (entry.hadDestination) fs.renameSync(entry.destination, entry.backup);
      faultInjector?.('backed-up', index);
    });
    manifest.state = 'publishing';
    writeJson(manifestPath, manifest);

    manifest.entries.forEach((entry, index) => {
      fs.renameSync(entry.stage, entry.destination);
      faultInjector?.('published', index);
    });
    manifest.state = 'committed';
    writeJson(manifestPath, manifest);
    faultInjector?.('committed', -1);

    finalizeCommittedManifest(manifest);
    safeUnlink(manifestPath);
  } catch (error) {
    if (error instanceof SimulatedProcessCrash) throw error;
    try {
      rollbackPublishManifest(manifest);
      safeUnlink(manifestPath);
    } catch (rollbackError) {
      throw new globalThis.AggregateError([error, rollbackError], 'Publication failed and rollback was incomplete');
    }
    throw error;
  }
}

export function recoverPublishArtifacts(directory) {
  if (!fs.existsSync(directory)) return;
  const manifests = fs.readdirSync(directory)
    .filter((name) => /^\.flyt-publish-[A-Za-z0-9-]+\.json$/.test(name))
    .map((name) => path.join(directory, name));

  manifests.forEach((manifestPath) => {
    const manifest = validatePublishManifest(readJson(manifestPath, null), manifestPath);
    if (manifest.state === 'committed') finalizeCommittedManifest(manifest);
    else rollbackPublishManifest(manifest);
    safeUnlink(manifestPath);
  });

  const artifacts = listFilesRecursive(directory);
  const orphanBackups = artifacts.filter((filePath) => filePath.endsWith('.bak'));
  if (orphanBackups.length) {
    throw new Error(
      `Unrecoverable publication backups without a transaction manifest: ${orphanBackups.join(', ')}`,
    );
  }
  artifacts.filter((filePath) => filePath.endsWith('.new')).forEach(safeUnlink);
}

export function buildTrackerArgs(trackerScript, inputPath, outputs, overrides = {}, defaults) {
  const numberOr = (value, fallback) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
  };
  const integerOr = (value, fallback, minimum = 0) => (
    Math.max(minimum, Math.floor(numberOr(value, fallback)))
  );
  const config = {
    minArea: integerOr(overrides.minArea, defaults.minArea),
    maxArea: integerOr(overrides.maxArea, defaults.maxArea),
    proximityThreshold: numberOr(overrides.proximityThreshold, defaults.proximityThreshold),
    boutMinFrames: integerOr(overrides.boutMinFrames, defaults.boutMinFrames, 1),
  };
  if (config.maxArea > 0 && config.maxArea <= config.minArea) config.maxArea = defaults.maxArea;
  return [
    trackerScript, '--input', inputPath,
    '--output-video', outputs.rawVideo,
    '--output-csv', outputs.csv,
    '--output-events', outputs.events,
    '--min-area', String(config.minArea),
    '--max-area', String(config.maxArea),
    '--proximity-threshold', String(config.proximityThreshold),
    '--bout-min-frames', String(config.boutMinFrames),
  ];
}

export function readEventsFps(eventsPath) {
  const data = readJson(eventsPath, null);
  return data && Number.isFinite(data.fps) ? data.fps : null;
}

export function readCsvAvgProximity(csvPath) {
  if (!fs.existsSync(csvPath)) return null;
  const lines = fs.readFileSync(csvPath, 'utf8').trim().split(/\r?\n/);
  if (lines.length < 2) return null;
  const headers = lines[0].split(',');
  const proximityIndex = headers.indexOf('proximity_distance');
  const occlusionIndex = headers.indexOf('occlusion_flag');
  const trackingValidIndex = headers.indexOf('tracking_valid');
  const detectionCountIndex = headers.indexOf('detection_count');
  const fly1AreaIndex = headers.indexOf('fly1_area');
  const fly2AreaIndex = headers.indexOf('fly2_area');
  if (proximityIndex < 0) return null;

  let total = 0;
  let count = 0;
  lines.slice(1).forEach((line) => {
    const columns = line.split(',');
    const rawProximity = columns[proximityIndex]?.trim();
    if (!rawProximity) return;
    const proximity = Number(rawProximity);
    const occluded = occlusionIndex >= 0 && Number(columns[occlusionIndex]) !== 0;
    let trackingValid = true;
    if (trackingValidIndex >= 0) {
      trackingValid = Number(columns[trackingValidIndex]) === 1;
    } else if (detectionCountIndex >= 0) {
      trackingValid = Number(columns[detectionCountIndex]) >= 2;
    } else if (fly1AreaIndex >= 0 && fly2AreaIndex >= 0) {
      trackingValid = Number(columns[fly1AreaIndex]) > 0 && Number(columns[fly2AreaIndex]) > 0;
    }
    if (Number.isFinite(proximity) && trackingValid && !occluded) {
      total += proximity;
      count += 1;
    }
  });
  return count ? Math.round((total / count) * 100) / 100 : null;
}

export function countCourtshipBouts(eventsPath) {
  const data = readJson(eventsPath, { events: [] });
  return Array.isArray(data.events)
    ? data.events.filter((event) => event.type === 'courtship_bout').length
    : 0;
}

const RUN_ID_PATTERN = /^run-[A-Za-z0-9][A-Za-z0-9-]{2,127}$/;

function requireRunId(runId) {
  if (!RUN_ID_PATTERN.test(String(runId))) throw new Error(`Invalid run ID: ${runId}`);
  return String(runId);
}

export function createRunId() {
  return `run-${Date.now()}-${randomUUID().slice(0, 8)}`;
}

export function scopeEventsForRun(eventsPath, runId, destinationPath = eventsPath) {
  const safeRunId = requireRunId(runId);
  const prefix = `${safeRunId}:`;
  const data = readJson(eventsPath, { version: 1, events: [] });
  data.run_id = safeRunId;
  data.events = Array.isArray(data.events) ? data.events.map((event) => {
    const currentId = String(event.id || '');
    const originalId = event.original_id
      || (currentId.startsWith(prefix) ? currentId.slice(prefix.length) : currentId);
    if (!originalId) throw new Error('Event ID missing while scoping run events');
    return {
      ...event,
      original_id: originalId,
      id: `${safeRunId}:${originalId}`,
    };
  }) : [];
  writeJson(destinationPath, data);
  return data;
}

export function scopeEventsForHistory(eventsPath, runId, destinationPath) {
  return scopeEventsForRun(eventsPath, runId, destinationPath);
}

export function prepareRunHistoryBundle({
  runId,
  historyDir,
  historyMetaPath,
  historyIndexOutput,
  filename,
  durationSec,
  fps,
  totalFrames,
  csvSrc,
  eventsSrc,
  verificationSrc,
}) {
  const safeRunId = requireRunId(runId);
  for (const source of [csvSrc, eventsSrc, verificationSrc]) {
    if (!fs.existsSync(source)) throw new Error(`Missing history source: ${source}`);
  }
  const history = readJson(historyMetaPath, { version: 1, runs: [] });
  if (!Array.isArray(history.runs)) history.runs = [];
  if (history.runs.some((run) => run.runId === safeRunId)) {
    throw new Error(`History run already exists: ${safeRunId}`);
  }
  const meta = {
    runId: safeRunId,
    timestamp: new Date().toISOString(),
    filename: filename || 'unknown',
    durationSec: Math.round((durationSec || 0) * 10) / 10,
    fps: fps || null,
    totalFrames: totalFrames || null,
    avgProximity: readCsvAvgProximity(csvSrc),
    detectedBouts: countCourtshipBouts(eventsSrc),
  };
  history.runs.unshift(meta);
  writeJson(historyIndexOutput, history);

  const runDir = path.join(historyDir, safeRunId);
  return {
    meta,
    entries: [
      { source: csvSrc, destination: path.join(runDir, 'data.csv') },
      { source: eventsSrc, destination: path.join(runDir, 'events.json') },
      { source: verificationSrc, destination: path.join(runDir, 'verification.json') },
      { source: historyIndexOutput, destination: historyMetaPath },
    ],
  };
}

export function verificationPathForRun(runId, historyDir, { mustExist = true } = {}) {
  const safeRunId = requireRunId(runId);
  const root = path.resolve(historyDir);
  const filePath = path.resolve(root, safeRunId, 'verification.json');
  if (!filePath.startsWith(`${root}${path.sep}`)) throw new Error('Verification path escaped history root');
  if (mustExist && !fs.existsSync(filePath)) throw new Error('Run verification file not found');
  return filePath;
}

export function resolveVerificationPath(eventId, historyDir) {
  const separator = String(eventId).indexOf(':');
  if (separator <= 0 || separator === String(eventId).length - 1) {
    throw new Error('Run-scoped event ID required');
  }
  return verificationPathForRun(String(eventId).slice(0, separator), historyDir);
}
