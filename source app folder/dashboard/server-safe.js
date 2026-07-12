import express from 'express';
import multer from 'multer';
import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import ffmpegPath from 'ffmpeg-static';
import {
  buildTrackerArgs,
  countCsvRows,
  ensureDir,
  getVideoFrameCount,
  parseTrackerSync,
  readEventsFps,
  readJson,
  replaceFile,
  safeRemoveDir,
  safeUnlink,
  snapshotRunToHistory,
  transcodeVideo,
  writeJson,
} from './server-safe-utils.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const PORT = 3001;

const uploadsDir = path.join(__dirname, 'uploads');
const publicDir = path.join(__dirname, 'public');
const historyDir = path.join(publicDir, 'history');
const historyMetaPath = path.join(publicDir, 'history.json');
const eventsPath = path.join(publicDir, 'events.json');
const verificationPath = path.join(publicDir, 'verification.json');
const runMetadataPath = path.join(publicDir, 'run_metadata.json');
const trackerDir = path.join(__dirname, '..', 'tracker');
const trackerScript = path.join(trackerDir, 'tracker_safe.py');
const isWindows = process.platform === 'win32';
const pythonExe = path.join(
  trackerDir,
  'venv',
  isWindows ? 'Scripts' : 'bin',
  isWindows ? 'python.exe' : 'python',
);

for (const dir of [uploadsDir, publicDir, historyDir]) ensureDir(dir);

const defaults = {
  minArea: 30,
  maxArea: 0,
  proximityThreshold: 60,
  boutMinFrames: 90,
};

const storage = multer.diskStorage({
  destination: (req, file, callback) => callback(null, uploadsDir),
  filename: (req, file, callback) => {
    const extension = path.extname(file.originalname).toLowerCase();
    callback(null, `input_${Date.now()}_${process.pid}${extension}`);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 * 1024 },
});

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
let activeTracker = null;

const blankJob = () => ({
  runId: null,
  status: 'idle',
  progress: '',
  framesProcessed: 0,
  totalFrames: null,
  frameCount: null,
  error: null,
  startTime: null,
  endTime: null,
});
let job = blankJob();

const isBusy = () => (
  uploadReserved
  || job.status === 'uploading'
  || job.status === 'processing'
);
const isCurrent = (context) => (
  context.epoch === epoch
  && context.runId === job.runId
);

function resetJob() {
  epoch += 1;
  if (activeTracker) {
    try { activeTracker.kill(); } catch { /* already exited */ }
    activeTracker = null;
  }
  job = blankJob();
}

function reserveUpload(req, res, next) {
  if (isBusy()) {
    return res.status(409).json({
      error: 'A video is already being uploaded or processed. Please wait.',
    });
  }

  uploadReserved = true;
  let released = false;
  const release = () => {
    if (!released) {
      released = true;
      uploadReserved = false;
    }
  };
  res.once('finish', release);
  res.once('close', release);
  return next();
}

function readVerification() {
  const data = readJson(verificationPath, { version: 1, reviews: [] });
  return Array.isArray(data.reviews)
    ? data
    : { version: 1, reviews: [] };
}

function resetVerification() {
  writeJson(verificationPath, { version: 1, reviews: [] });
}

function startTracking(inputPath, overrides) {
  const context = {
    runId: job.runId,
    epoch,
    startTime: Date.now(),
    stdout: '',
    filename: job.uploadedFilename,
  };
  const token = `${context.runId}-${context.epoch}`;
  const workDir = path.join(uploadsDir, `run-${token}`);
  ensureDir(workDir);

  const rawVideo = path.join(workDir, 'tracked_raw.mp4');
  const browserVideo = path.join(workDir, 'tracked.mp4');
  const csvPath = path.join(workDir, 'data.csv');
  const runEventsPath = path.join(workDir, 'events.json');

  job.status = 'processing';
  job.progress = 'Initializing tracker pipeline...';
  job.framesProcessed = 0;
  job.startTime = context.startTime;
  job.error = null;
  job.overrides = overrides;

  const tracker = spawn(
    pythonExe,
    buildTrackerArgs(
      trackerScript,
      inputPath,
      rawVideo,
      csvPath,
      runEventsPath,
      overrides,
      defaults,
    ),
  );
  activeTracker = tracker;

  const cleanup = () => {
    safeUnlink(inputPath);
    safeRemoveDir(workDir);
  };

  tracker.stdout.on('data', (chunk) => {
    const raw = chunk.toString();
    context.stdout += raw;
    const message = raw.trim();
    console.log(`[Tracker] ${message}`);
    if (!isCurrent(context)) return;

    const progress = message.match(/Processed (\d+) frames/);
    if (progress) {
      job.framesProcessed = parseInt(progress[1], 10);
      job.progress = `Processed ${job.framesProcessed} frames...`;
    } else if (message.includes('Tracking completed')) {
      job.progress = 'Finalizing output files...';
    } else if (message) {
      job.progress = message;
    }
  });

  tracker.stderr.on('data', (chunk) => {
    const raw = chunk.toString();
    context.stdout += raw;
    const message = raw.trim();
    if (message.includes('NAL unit') || message.includes('partial file')) {
      console.log(`[Tracker] (codec warning) ${message}`);
    } else {
      console.error(`[Tracker] ${message}`);
    }
  });

  tracker.on('error', (error) => {
    if (activeTracker === tracker) activeTracker = null;
    if (isCurrent(context)) {
      job.status = 'error';
      job.error = `Failed to start tracker: ${error.message}`;
      job.progress = '';
    }
    cleanup();
  });

  tracker.on('close', async (code) => {
    if (activeTracker === tracker) activeTracker = null;
    if (!isCurrent(context)) {
      cleanup();
      return;
    }

    const endTime = Date.now();
    const elapsed = ((endTime - context.startTime) / 1000).toFixed(1);
    job.endTime = endTime;

    if (code !== 0) {
      job.status = 'error';
      job.error = `Tracker exited with code ${code}`;
      job.progress = '';
      cleanup();
      return;
    }

    try {
      const syncInfo = parseTrackerSync(context.stdout);
      const csvRows = countCsvRows(csvPath);
      const videoFrames = fs.existsSync(rawVideo)
        ? await getVideoFrameCount(ffmpegPath, rawVideo)
        : null;

      if (!isCurrent(context)) {
        cleanup();
        return;
      }

      const frameCount = syncInfo?.framesProcessed ?? csvRows;
      const syncOk = (
        syncInfo?.syncOk !== false
        && csvRows === frameCount
        && (videoFrames === null || videoFrames === csvRows)
      );
      if (!syncOk) {
        throw new Error(
          `Frame sync mismatch (csv=${csvRows}, `
          + `video=${videoFrames}, tracker=${frameCount})`,
        );
      }
      if (!fs.existsSync(rawVideo)) {
        throw new Error('tracked_raw.mp4 missing after tracker completed');
      }

      job.progress = 'Transcoding video for browser playback...';
      await transcodeVideo(ffmpegPath, rawVideo, browserVideo);
      if (!isCurrent(context)) {
        cleanup();
        return;
      }

      const fps = readEventsFps(runEventsPath);
      const metadata = {
        framesProcessed: frameCount,
        csvRows,
        videoFrames,
        expectedVideoFrames: syncInfo?.expectedVideoFrames ?? null,
        syncOk,
        fps,
        timestamp: new Date().toISOString(),
      };

      replaceFile(csvPath, path.join(publicDir, 'data.csv'), token);
      replaceFile(runEventsPath, eventsPath, token);
      replaceFile(browserVideo, path.join(publicDir, 'tracked.mp4'), token);
      writeJson(runMetadataPath, metadata);

      try {
        snapshotRunToHistory({
          historyDir,
          historyMetaPath,
          runId: context.runId,
          filename: context.filename,
          durationSec: parseFloat(elapsed),
          fps,
          totalFrames: frameCount,
          csvSrc: csvPath,
          eventsSrc: runEventsPath,
        });
      } catch (historyError) {
        console.error(`[Server] History snapshot failed: ${historyError.message}`);
      }

      job.frameCount = frameCount;
      job.framesProcessed = frameCount;
      job.status = 'done';
      job.progress = `Tracking complete! Processed ${frameCount} frames in ${elapsed}s`;
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

app.get('/api/status', (req, res) => res.json({ ...job }));

app.post('/api/upload', reserveUpload, upload.single('video'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No video file provided' });
  }
  if (job.status === 'uploading' || job.status === 'processing') {
    safeUnlink(req.file.path);
    return res.status(409).json({
      error: 'A video is already being processed. Please wait.',
    });
  }

  resetJob();
  resetVerification();
  runSequence += 1;
  job.runId = runSequence;
  job.status = 'uploading';
  job.progress = 'Video uploaded, starting tracker...';
  job.uploadedFilename = req.file.originalname;

  const overrides = {
    minArea: req.body.minArea,
    maxArea: req.body.maxArea,
    proximityThreshold: req.body.proximityThreshold,
    boutMinFrames: req.body.boutMinFrames,
  };

  startTracking(req.file.path, overrides);
  return res.json({
    success: true,
    message: 'Upload received, processing started',
    runId: runSequence,
  });
});

app.post('/api/reset', (req, res) => {
  resetJob();
  res.json({ success: true });
});

app.get('/api/events', (req, res) => {
  const data = readJson(eventsPath, null);
  if (!data) return res.status(404).json({ error: 'No events file found.' });
  return res.json(data);
});

app.get('/api/verification', (req, res) => res.json(readVerification()));

app.post('/api/verification', (req, res) => {
  const { eventId, verdict } = req.body || {};
  if (!eventId || !['confirmed', 'rejected'].includes(verdict)) {
    return res.status(400).json({
      error: 'Body must include eventId and verdict (confirmed|rejected)',
    });
  }

  const data = readVerification();
  const review = {
    event_id: eventId,
    verdict,
    reviewed_at: new Date().toISOString(),
  };
  const index = data.reviews.findIndex((item) => item.event_id === eventId);
  if (index >= 0) data.reviews[index] = review;
  else data.reviews.push(review);
  writeJson(verificationPath, data);
  return res.json({ success: true, review });
});

app.post('/api/verification/reset', (req, res) => {
  resetVerification();
  res.json({ success: true });
});

app.get('/api/history', (req, res) => {
  const history = readJson(historyMetaPath, { version: 1, runs: [] });
  res.json(Array.isArray(history.runs) ? history : { version: 1, runs: [] });
});

app.delete('/api/history', (req, res) => {
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
  console.log('\n  🧬 Flyt API Server (safe job runner)');
  console.log(`  ➜  Running on http://localhost:${PORT}`);
  console.log(`  ➜  Tracker: ${trackerScript}`);
});
