import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

export function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
}

export function safeUnlink(filePath) {
  if (!filePath) return;
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch (error) {
    console.error(`[Server] Failed to remove ${filePath}: ${error.message}`);
  }
}

export function safeRemoveDir(dirPath) {
  if (!dirPath) return;
  try {
    fs.rmSync(dirPath, { recursive: true, force: true });
  } catch (error) {
    console.error(`[Server] Failed to remove ${dirPath}: ${error.message}`);
  }
}

export function replaceFile(sourcePath, destinationPath, token) {
  const tempPath = `${destinationPath}.${token}.tmp`;
  fs.copyFileSync(sourcePath, tempPath);
  if (fs.existsSync(destinationPath)) fs.unlinkSync(destinationPath);
  fs.renameSync(tempPath, destinationPath);
}

export function countCsvRows(csvPath) {
  const content = fs.readFileSync(csvPath, 'utf8').trim();
  return content ? content.split('\n').length - 1 : 0;
}

export function getVideoFrameCount(ffmpegPath, videoPath) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, [
      '-i', videoPath,
      '-map', '0:v:0',
      '-f', 'null',
      '-',
    ]);
    let stderr = '';
    child.stderr.on('data', (data) => { stderr += data.toString(); });
    child.on('close', () => {
      const matches = [...stderr.matchAll(/frame=\s*(\d+)/g)];
      if (matches.length) {
        resolve(parseInt(matches.at(-1)[1], 10));
      } else {
        reject(new Error('Could not determine video frame count from ffmpeg'));
      }
    });
    child.on('error', reject);
  });
}

export function parseTrackerSync(stdout) {
  const match = stdout.match(
    /TRACKER_SYNC frames_processed=(\d+) csv_rows=(\d+) expected_video_frames=(\d+) sync_ok=(true|false)/,
  );
  if (!match) return null;
  return {
    framesProcessed: parseInt(match[1], 10),
    csvRows: parseInt(match[2], 10),
    expectedVideoFrames: parseInt(match[3], 10),
    syncOk: match[4] === 'true',
  };
}

export function readJson(filePath, fallback) {
  if (!fs.existsSync(filePath)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

export function writeJson(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

export function readEventsFps(eventsPath) {
  const data = readJson(eventsPath, null);
  return data && typeof data.fps === 'number' ? data.fps : null;
}

export function readCsvAvgProximity(csvPath) {
  if (!fs.existsSync(csvPath)) return null;
  try {
    const lines = fs.readFileSync(csvPath, 'utf8').trim().split('\n');
    if (lines.length < 2) return null;
    const header = lines[0].split(',');
    const proxIdx = header.indexOf('proximity_distance');
    const occIdx = header.indexOf('occlusion_flag');
    if (proxIdx < 0) return null;

    let sum = 0;
    let count = 0;
    for (let i = 1; i < lines.length; i += 1) {
      const cols = lines[i].split(',');
      const value = parseFloat(cols[proxIdx]);
      const occluded = occIdx >= 0 && parseInt(cols[occIdx], 10) === 1;
      if (Number.isFinite(value) && !occluded) {
        sum += value;
        count += 1;
      }
    }
    return count ? Math.round((sum / count) * 100) / 100 : null;
  } catch {
    return null;
  }
}

export function countCourtshipBouts(eventsPath) {
  const data = readJson(eventsPath, { events: [] });
  return Array.isArray(data.events)
    ? data.events.filter((event) => event.type === 'courtship_bout').length
    : 0;
}

export function snapshotRunToHistory({
  historyDir,
  historyMetaPath,
  runId,
  filename,
  durationSec,
  fps,
  totalFrames,
  csvSrc,
  eventsSrc,
}) {
  if (!fs.existsSync(csvSrc)) return null;

  const stampedId = `run-${Date.now()}-${String(runId).padStart(4, '0')}`;
  const runDir = path.join(historyDir, stampedId);
  ensureDir(runDir);
  fs.copyFileSync(csvSrc, path.join(runDir, 'data.csv'));
  if (fs.existsSync(eventsSrc)) {
    fs.copyFileSync(eventsSrc, path.join(runDir, 'events.json'));
  }

  const meta = {
    runId: stampedId,
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

export function transcodeVideo(ffmpegPath, rawPath, finalPath) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, [
      '-i', rawPath,
      '-vcodec', 'libx264',
      '-preset', 'veryfast',
      '-pix_fmt', 'yuv420p',
      '-movflags', '+faststart',
      '-an',
      '-y',
      finalPath,
    ]);
    let stderr = '';
    child.stderr.on('data', (data) => { stderr += data.toString(); });
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(
        `ffmpeg transcode failed (exit ${code}): ${stderr.slice(-500)}`,
      ));
    });
    child.on('error', (error) => reject(new Error(
      `Failed to start ffmpeg: ${error.message}`,
    )));
  });
}

export function buildTrackerArgs(
  trackerScript,
  inputPath,
  outputVideo,
  outputCsv,
  outputEvents,
  overrides,
  defaults,
) {
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
    proximityThreshold: numberOr(
      overrides.proximityThreshold,
      defaults.proximityThreshold,
    ),
    boutMinFrames: integerOr(
      overrides.boutMinFrames,
      defaults.boutMinFrames,
      1,
    ),
  };
  if (config.maxArea > 0 && config.maxArea <= config.minArea) {
    config.maxArea = defaults.maxArea;
  }

  return [
    trackerScript,
    '--input', inputPath,
    '--output-video', outputVideo,
    '--output-csv', outputCsv,
    '--output-events', outputEvents,
    '--min-area', String(config.minArea),
    '--max-area', String(config.maxArea),
    '--proximity-threshold', String(config.proximityThreshold),
    '--bout-min-frames', String(config.boutMinFrames),
  ];
}
