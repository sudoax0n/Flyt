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

  if (syncInfo.expectedVideoFrames > 0) {
    requirePositiveInteger('trackerExpectedFrames', syncInfo.expectedVideoFrames);
    counts.trackerExpectedFrames = syncInfo.expectedVideoFrames;
  }

  const unique = new Set(Object.values(counts));
  if (unique.size !== 1) {
    const detail = Object.entries(counts).map(([key, value]) => `${key}=${value}`).join(', ');
    throw new Error(`Frame integrity mismatch (${detail})`);
  }

  return { ...counts, syncOk: true };
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

export function publishBundle(entries, token, { faultInjector } = {}) {
  const staged = [];
  const backups = [];
  const published = [];
  try {
    for (const { source, destination } of entries) {
      if (!fs.existsSync(source)) throw new Error(`Missing publish source: ${source}`);
      ensureDir(path.dirname(destination));
      const stage = `${destination}.${token}.new`;
      fs.copyFileSync(source, stage);
      staged.push(stage);
    }
    faultInjector?.('staged', -1);

    for (const { destination } of entries) {
      if (fs.existsSync(destination)) {
        const backup = `${destination}.${token}.bak`;
        fs.renameSync(destination, backup);
        backups.push({ destination, backup });
      }
    }
    faultInjector?.('backed-up', -1);

    entries.forEach(({ destination }, index) => {
      fs.renameSync(staged[index], destination);
      published.push(destination);
      faultInjector?.('published', index);
    });
    backups.forEach(({ backup }) => safeUnlink(backup));
  } catch (error) {
    published.reverse().forEach((destination) => safeUnlink(destination));
    backups.reverse().forEach(({ destination, backup }) => {
      if (fs.existsSync(backup)) fs.renameSync(backup, destination);
    });
    staged.forEach((stage) => safeUnlink(stage));
    throw error;
  }
}

export function recoverPublishArtifacts(directory) {
  if (!fs.existsSync(directory)) return;
  const names = fs.readdirSync(directory);
  names.filter((name) => name.endsWith('.new')).forEach((name) => safeUnlink(path.join(directory, name)));
  names.filter((name) => name.endsWith('.bak')).forEach((name) => {
    const backup = path.join(directory, name);
    const destination = backup.replace(/\.[^.]+\.bak$/, '');
    if (!fs.existsSync(destination)) fs.renameSync(backup, destination);
    else safeUnlink(backup);
  });
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
  if (proximityIndex < 0) return null;
  let total = 0;
  let count = 0;
  lines.slice(1).forEach((line) => {
    const columns = line.split(',');
    const proximity = Number(columns[proximityIndex]);
    const occluded = occlusionIndex >= 0 && Number(columns[occlusionIndex]) === 1;
    if (Number.isFinite(proximity) && !occluded) {
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

export function scopeEventsForHistory(eventsPath, runId, destinationPath) {
  const data = readJson(eventsPath, { version: 1, events: [] });
  data.events = Array.isArray(data.events) ? data.events.map((event) => ({
    ...event,
    original_id: event.original_id || event.id,
    id: `${runId}:${event.original_id || event.id}`,
  })) : [];
  writeJson(destinationPath, data);
}

export function snapshotRunToHistory({
  historyDir, historyMetaPath, filename, durationSec, fps, totalFrames, csvSrc, eventsSrc,
}) {
  if (!fs.existsSync(csvSrc)) return null;
  const runId = `run-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const runDir = path.join(historyDir, runId);
  ensureDir(runDir);
  fs.copyFileSync(csvSrc, path.join(runDir, 'data.csv'));
  scopeEventsForHistory(eventsSrc, runId, path.join(runDir, 'events.json'));
  writeJson(path.join(runDir, 'verification.json'), { version: 1, reviews: [] });
  const meta = {
    runId,
    timestamp: new Date().toISOString(),
    filename: filename || 'unknown',
    durationSec: Math.round((durationSec || 0) * 10) / 10,
    fps: fps || null,
    totalFrames: totalFrames || null,
    avgProximity: readCsvAvgProximity(csvSrc),
    detectedBouts: countCourtshipBouts(eventsSrc),
  };
  const history = readJson(historyMetaPath, { version: 1, runs: [] });
  if (!Array.isArray(history.runs)) history.runs = [];
  history.runs.unshift(meta);
  writeJson(historyMetaPath, history);
  return meta;
}

export function resolveVerificationPath(eventId, currentPath, historyDir, historyMetaPath) {
  const separator = eventId.indexOf(':');
  if (separator < 0) return currentPath;
  const runId = eventId.slice(0, separator);
  const history = readJson(historyMetaPath, { runs: [] });
  const exists = Array.isArray(history.runs) && history.runs.some((run) => run.runId === runId);
  if (!exists) throw new Error('Unknown historical run');
  return path.join(historyDir, runId, 'verification.json');
}
