import { randomUUID } from 'crypto';
import { spawn } from 'child_process';
import express from 'express';
import ffmpegPath from 'ffmpeg-static';
import fs from 'fs';
import multer from 'multer';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  buildTrackerArgs,
  countCsvRows,
  ensureDir,
  getVideoFrameCount,
  parseTrackerSync,
  publishBundle,
  readEventsFps,
  readJson,
  resolveVerificationPath,
  safeRemoveDir,
  safeUnlink,
  snapshotRunToHistory,
  transcodeVideo,
  writeJson,
} from './server-utils.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = 3001;
const uploadsDir = path.join(__dirname, 'uploads');
const publicDir = path.join(__dirname, 'public');
const historyDir = path.join(publicDir, 'history');
const historyMetaPath = path.join(publicDir, 'history.json');
const verificationPath = path.join(publicDir, 'verification.json');
const trackerDir = path.join(__dirname, '..', 'tracker');
const trackerScript = path.join(trackerDir, 'tracker.py');
const isWindows = process.platform === 'win32';
const pythonExe = path.join(
  trackerDir, 'venv', isWindows ? 'Scripts' : 'bin', isWindows ? 'python.exe' : 'python',
);
const defaults = { minArea: 30, maxArea: 0, proximityThreshold: 60, boutMinFrames: 90 };
for (const dir of [uploadsDir, publicDir, historyDir]) ensureDir(dir);

const storage = multer.diskStorage({
  destination: (_req, _file, callback) => callback(null, uploadsDir),
  filename: (_req, file, callback) => {
    callback(null, `input-${Date.now()}-${randomUUID()}${path.extname(file.originalname).toLowerCase()}`);
  },
});
const upload = multer({ storage, limits: { fileSize: 10 * 1024 * 1024 * 1024 } });

app.use(express.json());
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  return next();
});

let runSequence = 0;
let epoch = 0;
let uploadReserved = false;
let terminating = false;
let activeTracker = null;
let job = blankJob();

function blankJob() {
  return {
    runId: null, status: 'idle', progress: '', framesProcessed: 0,
    totalFrames: null, frameCount: null, error: null, startTime: null, endTime: null,
  };
}

const isBusy = () => uploadReserved || terminating || ['uploading', 'processing'].includes(job.status);
const isCurrent = (context) => context.epoch === epoch && context.runId === job.runId;

function reserveUpload(req, res, next) {
  if (isBusy()) return res.status(409).json({ error: 'A video is already uploading, processing, or stopping.' });
  req.uploadEpoch = epoch;
  uploadReserved = true;
  let released = false;
  const release = () => { if (!released) { released = true; uploadReserved = false; } };
  res.once('finish', release);
  res.once('close', release);
  return next();
}

function stopActiveTracker() {
  epoch += 1;
  const tracker = activeTracker;
  activeTracker = null;
  job = blankJob();
  if (!tracker) return Promise.resolve();
  terminating = true;
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      terminating = false;
      resolve();
    };
    tracker.once('close', finish);
    tracker.once('error', finish);
    try { tracker.kill(); } catch { finish(); }
    setTimeout(finish, 3000).unref();
  });
}

function readVerification(filePath = verificationPath) {
  const data = readJson(filePath, { version: 1, reviews: [] });
  return Array.isArray(data.reviews) ? data : { version: 1, reviews: [] };
}

function startTracking(inputPath, overrides) {
  const context = {
    runId: job.runId,
    epoch,
    startedAt: Date.now(),
    stdout: '',
    filename: job.uploadedFilename,
    spawnFailed: false,
  };
  const token = `${context.runId}-${context.epoch}-${randomUUID()}`;
  const workDir = path.join(uploadsDir, `run-${token}`);
  ensureDir(workDir);
  const outputs = {
    rawVideo: path.join(workDir, 'tracked_raw.mp4'),
    browserVideo: path.join(workDir, 'tracked.mp4'),
    csv: path.join(workDir, 'data.csv'),
    events: path.join(workDir, 'events.json'),
    metadata: path.join(workDir, 'run_metadata.json'),
    verification: path.join(workDir, 'verification.json'),
  };

  job = {
    ...job,
    status: 'processing',
    progress: 'Initializing tracker pipeline...',
    framesProcessed: 0,
    startTime: context.startedAt,
    error: null,
    overrides,
  };

  const tracker = spawn(
    pythonExe,
    buildTrackerArgs(trackerScript, inputPath, outputs, overrides, defaults),
  );
  activeTracker = tracker;
  const cleanup = () => { safeUnlink(inputPath); safeRemoveDir(workDir); };

  tracker.stdout.on('data', (chunk) => {
    const raw = chunk.toString();
    context.stdout += raw;
    if (!isCurrent(context)) return;
    const match = raw.match(/Processed (\d+) frames/);
    if (match) {
      job.framesProcessed = Number(match[1]);
      job.progress = `Processed ${job.framesProcessed} frames...`;
    } else if (raw.includes('Tracking completed')) {
      job.progress = 'Finalizing output files...';
    }
  });
  tracker.stderr.on('data', (chunk) => {
    context.stdout += chunk.toString();
    console.error(`[Tracker] ${chunk.toString().trim()}`);
  });

  tracker.once('error', (error) => {
    context.spawnFailed = true;
    if (activeTracker === tracker) activeTracker = null;
    if (isCurrent(context)) {
      job.status = 'error';
      job.error = `Failed to start tracker: ${error.message}`;
      job.progress = '';
    }
    cleanup();
  });

  tracker.once('close', async (code) => {
    if (activeTracker === tracker) activeTracker = null;
    if (context.spawnFailed) return;
    if (!isCurrent(context)) { cleanup(); return; }
    job.endTime = Date.now();
    if (code !== 0) {
      job.status = 'error';
      job.error = `Tracker exited with code ${code}`;
      job.progress = '';
      cleanup();
      return;
    }
    try {
      const syncInfo = parseTrackerSync(context.stdout);
      const csvRows = countCsvRows(outputs.csv);
      const videoFrames = fs.existsSync(outputs.rawVideo)
        ? await getVideoFrameCount(ffmpegPath, outputs.rawVideo)
        : null;
      if (!isCurrent(context)) { cleanup(); return; }
      const frameCount = syncInfo?.framesProcessed ?? csvRows;
      const syncOk = syncInfo?.syncOk !== false
        && csvRows === frameCount
        && (videoFrames === null || videoFrames === csvRows);
      if (!syncOk) throw new Error(
        `Frame sync mismatch (csv=${csvRows}, video=${videoFrames}, tracker=${frameCount})`,
      );
      if (!fs.existsSync(outputs.rawVideo)) throw new Error('tracked_raw.mp4 missing');

      job.progress = 'Transcoding video for browser playback...';
      await transcodeVideo(ffmpegPath, outputs.rawVideo, outputs.browserVideo);
      if (!isCurrent(context)) { cleanup(); return; }

      const fps = readEventsFps(outputs.events);
      const metadata = {
        framesProcessed: frameCount,
        csvRows,
        videoFrames,
        expectedVideoFrames: syncInfo?.expectedVideoFrames ?? null,
        syncOk,
        fps,
        timestamp: new Date().toISOString(),
      };
      writeJson(outputs.metadata, metadata);
      writeJson(outputs.verification, { version: 1, reviews: [] });

      publishBundle([
        { source: outputs.csv, destination: path.join(publicDir, 'data.csv') },
        { source: outputs.events, destination: path.join(publicDir, 'events.json') },
        { source: outputs.browserVideo, destination: path.join(publicDir, 'tracked.mp4') },
        { source: outputs.metadata, destination: path.join(publicDir, 'run_metadata.json') },
        { source: outputs.verification, destination: verificationPath },
      ], token);

      try {
        snapshotRunToHistory({
          historyDir,
          historyMetaPath,
          filename: context.filename,
          durationSec: (job.endTime - context.startedAt) / 1000,
          fps,
          totalFrames: frameCount,
          csvSrc: outputs.csv,
          eventsSrc: outputs.events,
        });
      } catch (historyError) {
        console.error(`[Server] History snapshot failed: ${historyError.message}`);
      }

      job.frameCount = frameCount;
      job.framesProcessed = frameCount;
      job.status = 'done';
      job.progress = `Tracking complete! Processed ${frameCount} frames.`;
    } catch (error) {
      if (isCurrent(context)) {
        job.status = 'error';
        job.error = error.message;
        job.progress = '';
      }
      console.error(`[Server] Post-processing failed: ${error.message}`);
    } finally {
      cleanup();
    }
  });
}

app.get('/api/status', (_req, res) => res.json({ ...job }));

app.post('/api/upload', reserveUpload, upload.single('video'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No video file provided' });
  if (req.uploadEpoch !== epoch) {
    safeUnlink(req.file.path);
    return res.status(409).json({ error: 'Upload was cancelled by a reset.' });
  }
  await stopActiveTracker();
  runSequence += 1;
  job = {
    ...blankJob(),
    runId: runSequence,
    status: 'uploading',
    progress: 'Video uploaded, starting tracker...',
    uploadedFilename: req.file.originalname,
  };
  const overrides = {
    minArea: req.body.minArea,
    maxArea: req.body.maxArea,
    proximityThreshold: req.body.proximityThreshold,
    boutMinFrames: req.body.boutMinFrames,
  };
  startTracking(req.file.path, overrides);
  return res.json({ success: true, runId: runSequence });
});

app.post('/api/reset', async (_req, res) => {
  await stopActiveTracker();
  res.json({ success: true });
});

app.get('/api/events', (_req, res) => {
  const data = readJson(path.join(publicDir, 'events.json'), null);
  if (!data) return res.status(404).json({ error: 'No events file found.' });
  return res.json(data);
});

app.get('/api/verification', (req, res) => {
  if (!req.query.runId) return res.json(readVerification());
  const history = readJson(historyMetaPath, { runs: [] });
  const known = history.runs?.some((run) => run.runId === req.query.runId);
  if (!known) return res.status(404).json({ error: 'Run not found' });
  return res.json(readVerification(path.join(historyDir, req.query.runId, 'verification.json')));
});

app.post('/api/verification', (req, res) => {
  const { eventId, verdict } = req.body || {};
  if (!eventId || !['confirmed', 'rejected'].includes(verdict)) {
    return res.status(400).json({ error: 'Body must include eventId and verdict.' });
  }
  try {
    const filePath = resolveVerificationPath(
      eventId, verificationPath, historyDir, historyMetaPath,
    );
    const data = readVerification(filePath);
    const review = { event_id: eventId, verdict, reviewed_at: new Date().toISOString() };
    const index = data.reviews.findIndex((item) => item.event_id === eventId);
    if (index >= 0) data.reviews[index] = review;
    else data.reviews.push(review);
    writeJson(filePath, data);
    return res.json({ success: true, review });
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
});

app.post('/api/verification/reset', (_req, res) => {
  writeJson(verificationPath, { version: 1, reviews: [] });
  res.json({ success: true });
});

app.get('/api/history', (_req, res) => {
  res.json(readJson(historyMetaPath, { version: 1, runs: [] }));
});

app.delete('/api/history', (_req, res) => {
  writeJson(historyMetaPath, { version: 1, runs: [] });
  res.json({ success: true });
});

app.get('/api/history/:runId', (req, res) => {
  const history = readJson(historyMetaPath, { runs: [] });
  const entry = history.runs?.find((run) => run.runId === req.params.runId);
  if (!entry) return res.status(404).json({ error: 'Run not found' });
  return res.json(entry);
});

app.listen(PORT, () => {
  console.log(`\n  🧬 Flyt API Server\n  ➜  http://localhost:${PORT}\n  ➜  Tracker: ${trackerScript}`);
});
