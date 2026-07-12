import { randomUUID } from 'crypto';
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

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
  const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(data, null, 2));
  fs.renameSync(tempPath, filePath);
}

export function countCsvRows(csvPath) {
  const content = fs.readFileSync(csvPath, 'utf8').trim();
  return content ? content.split(/\r?\n/).length - 1 : 0;
}

export function parseTrackerSync(stdout) {
  const match = stdout.match(
    /TRACKER_SYNC frames_processed=(\d+) csv_rows=(\d+) expected_video_frames=(\d+) sync_ok=(true|false)/,
  );
  if (!match) return null;
  return {
    framesProcessed: Number(match[1]),
    csvRows: Number(match[2]),
    expectedVideoFrames: Number(match[3]),
    syncOk: match[4] === 'true',
  };
}

export function getVideoFrameCount(ffmpegPath, videoPath) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, ['-i', videoPath, '-map', '0:v:0', '-f', 'null', '-']);
    let stderr = '';
    child.stderr.on('data', (data) => { stderr += data.toString(); });
    child.once('error', reject);
    child.once('close', () => {
      const matches = [...stderr.matchAll(/frame=\s*(\d+)/g)];
      if (!matches.length) reject(new Error('Could not determine video frame count from ffmpeg'));
      else resolve(Number(matches.at(-1)[1]));
    });
  });
}

export function transcodeVideo(ffmpegPath, rawPath, finalPath) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, [
      '-i', rawPath, '-vcodec', 'libx264', '-preset', 'veryfast',
      '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-an', '-y', finalPath,
    ]);
    let stderr = '';
    child.stderr.on('data', (data) => { stderr += data.toString(); });
    child.once('error', (error) => reject(new Error(`Failed to start ffmpeg: ${error.message}`)));
    child.once('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg transcode failed (exit ${code}): ${stderr.slice(-500)}`));
    });
  });
}

export function publishBundle(entries, token) {
  const staged = [];
  const backups = [];
  const published = [];
  try {
    for (const { source, destination } of entries) {
      if (!fs.existsSync(source)) throw new Error(`Missing publish source: ${source}`);
      const stage = `${destination}.${token}.new`;
      fs.copyFileSync(source, stage);
      staged.push(stage);
    }
    for (const { destination } of entries) {
      if (fs.existsSync(destination)) {
        const backup = `${destination}.${token}.bak`;
        fs.renameSync(destination, backup);
        backups.push({ destination, backup });
      }
    }
    entries.forEach(({ destination }, index) => {
      fs.renameSync(staged[index], destination);
      published.push(destination);
    });
    backups.forEach(({ backup }) => safeUnlink(backup));
  } catch (error) {
    published.forEach((destination) => safeUnlink(destination));
    backups.reverse().forEach(({ destination, backup }) => {
      if (fs.existsSync(backup)) fs.renameSync(backup, destination);
    });
    staged.forEach((stage) => safeUnlink(stage));
    throw error;
  }
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
