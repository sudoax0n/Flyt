import express from 'express';
import multer from 'multer';
import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import ffmpegPath from 'ffmpeg-static';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = 3001;

// Configure multer for file uploads
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}
// History snapshots directory (created lazily on first snapshot, but ensure now
// so GET /api/history works even before any run completes).
const publicDirTmp = path.join(__dirname, 'public');
const historyDirInit = path.join(publicDirTmp, 'history');
if (!fs.existsSync(historyDirInit)) {
  fs.mkdirSync(historyDirInit, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => cb(null, 'input_video' + path.extname(file.originalname))
});
const upload = multer({ storage, limits: { fileSize: 10 * 1024 * 1024 * 1024 } }); // 10GB limit

// Paths
const trackerDir = path.join(__dirname, '..', 'tracker');
const trackerScript = path.join(trackerDir, 'tracker.py');
// Platform-agnostic venv python: Windows → venv/Scripts/python.exe, POSIX → venv/bin/python
const isWindows = process.platform === 'win32';
const pythonExe = path.join(trackerDir, 'venv', isWindows ? 'Scripts' : 'bin', isWindows ? 'python.exe' : 'python');
const publicDir = path.join(__dirname, 'public');

// Tracker defaults. Overridable per-run via Settings UI → /api/upload body.
// These mirror the pitch baseline; kept here so an empty Settings payload still
// produces pitch-identical output.
const TRACKER_DEFAULTS = {
  minArea: 30,
  maxArea: 0,
  proximityThreshold: 60,
  boutMinFrames: 90,
};

const EVENTS_PATH = path.join(publicDir, 'events.json');
const VERIFICATION_PATH = path.join(publicDir, 'verification.json');

app.use(express.json());

// Enable CORS for dev
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  next();
});

// ============================================================
// ASYNC JOB SYSTEM — never blocks the HTTP request
// ============================================================
let runId = 0;

let job = {
  runId: null,
  status: 'idle',         // idle | uploading | processing | done | error
  progress: '',           // human-readable progress string
  framesProcessed: 0,
  totalFrames: null,
  frameCount: null,       // verified frame count after sync check
  error: null,
  startTime: null,
  endTime: null,
};

let activeTracker = null;
let trackerStdout = '';

function resetJob() {
  if (activeTracker) {
    try { activeTracker.kill(); } catch { /* ignore */ }
    activeTracker = null;
  }
  trackerStdout = '';
  job = {
    runId: null,
    status: 'idle',
    progress: '',
    framesProcessed: 0,
    totalFrames: null,
    frameCount: null,
    error: null,
    startTime: null,
    endTime: null,
  };
}

function countCsvRows(csvPath) {
  const content = fs.readFileSync(csvPath, 'utf8').trim();
  if (!content) return 0;
  return content.split('\n').length - 1;
}

function getVideoFrameCount(videoPath) {
  return new Promise((resolve, reject) => {
    // Decode to null muxer — frame= count appears in stderr (copy mode skips it).
    const ffprobe = spawn(ffmpegPath, [
      '-i', videoPath,
      '-map', '0:v:0',
      '-f', 'null',
      '-',
    ]);

    let stderr = '';
    ffprobe.stderr.on('data', (data) => { stderr += data.toString(); });

    ffprobe.on('close', () => {
      const matches = [...stderr.matchAll(/frame=\s*(\d+)/g)];
      if (matches.length > 0) {
        resolve(parseInt(matches[matches.length - 1][1], 10));
        return;
      }
      reject(new Error('Could not determine video frame count from ffmpeg'));
    });

    ffprobe.on('error', (err) => reject(err));
  });
}

function parseTrackerSync(stdout) {
  const match = stdout.match(
    /TRACKER_SYNC frames_processed=(\d+) csv_rows=(\d+) expected_video_frames=(\d+) sync_ok=(true|false)/
  );
  if (!match) return null;
  return {
    framesProcessed: parseInt(match[1], 10),
    csvRows: parseInt(match[2], 10),
    expectedVideoFrames: parseInt(match[3], 10),
    syncOk: match[4] === 'true',
  };
}

function writeRunMetadata(metadata) {
  const metadataPath = path.join(publicDir, 'run_metadata.json');
  fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2));
}

function readEventsFps() {
  if (!fs.existsSync(EVENTS_PATH)) return null;
  try {
    const eventsData = JSON.parse(fs.readFileSync(EVENTS_PATH, 'utf8'));
    return typeof eventsData.fps === 'number' ? eventsData.fps : null;
  } catch {
    return null;
  }
}

function readVerification() {
  if (!fs.existsSync(VERIFICATION_PATH)) return { version: 1, reviews: [] };
  try {
    const data = JSON.parse(fs.readFileSync(VERIFICATION_PATH, 'utf8'));
    if (!Array.isArray(data.reviews)) return { version: 1, reviews: [] };
    return data;
  } catch {
    return { version: 1, reviews: [] };
  }
}

function writeVerification(data) {
  fs.writeFileSync(VERIFICATION_PATH, JSON.stringify(data, null, 2));
}

function resetVerification() {
  writeVerification({ version: 1, reviews: [] });
}

// ============================================================
// RUN HISTORY — per-run snapshots of CSV + events in public/history/<runId>/
// Metadata lives in public/history.json. Tracked video is NOT snapshotted
// (disk); past-run video falls back to "not available".
// ============================================================
const HISTORY_DIR = path.join(publicDir, 'history');
const HISTORY_META_PATH = path.join(publicDir, 'history.json');

function readHistoryMeta() {
  if (!fs.existsSync(HISTORY_META_PATH)) return { version: 1, runs: [] };
  try {
    const data = JSON.parse(fs.readFileSync(HISTORY_META_PATH, 'utf8'));
    if (!Array.isArray(data.runs)) return { version: 1, runs: [] };
    return data;
  } catch {
    return { version: 1, runs: [] };
  }
}

function writeHistoryMeta(data) {
  fs.writeFileSync(HISTORY_META_PATH, JSON.stringify(data, null, 2));
}


function readCsvAvgProximity(csvPath) {
  if (!fs.existsSync(csvPath)) return null;
  try {
    const lines = fs.readFileSync(csvPath, 'utf8').trim().split('\n');
    if (lines.length < 2) return null;
    const header = lines[0].split(',');
    const proxIdx = header.indexOf('proximity_distance');
    const occIdx = header.indexOf('occlusion_flag');
    if (proxIdx < 0) return null;
    let sum = 0, count = 0;
    for (let i = 1; i < lines.length; i++) {
      const cols = lines[i].split(',');
      const v = parseFloat(cols[proxIdx]);
      const isOccluded = occIdx >= 0 ? parseInt(cols[occIdx], 10) === 1 : false;
      if (Number.isFinite(v) && !isOccluded) {
        sum += v;
        count++;
      }
    }
    return count > 0 ? Math.round((sum / count) * 100) / 100 : null;
  } catch {
    return null;
  }
}

function countCourtshipBouts(eventsPath) {
  if (!fs.existsSync(eventsPath)) return 0;
  try {
    const data = JSON.parse(fs.readFileSync(eventsPath, 'utf8'));
    if (!Array.isArray(data.events)) return 0;
    return data.events.filter((e) => e.type === 'courtship_bout').length;
  } catch {
    return 0;
  }
}

// Snapshot data.csv + events.json for the just-finished run.
// Call AFTER all sync checks pass, BEFORE deleting raw video.
function snapshotRunToHistory({ runId, filename, durationSec, fps, totalFrames }) {
  const csvSrc = path.join(publicDir, 'data.csv');
  const eventsSrc = EVENTS_PATH;
  if (!fs.existsSync(csvSrc)) return null;

  const stampedId = `run-${String(runId).padStart(4, '0')}`;
  const runDir = path.join(HISTORY_DIR, stampedId);
  fs.mkdirSync(runDir, { recursive: true });
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

  const history = readHistoryMeta();
  history.runs.unshift(meta); // newest first
  writeHistoryMeta(history);
  return meta;
}

function transcodeVideo(rawPath, finalPath) {
  return new Promise((resolve, reject) => {
    const args = [
      '-i', rawPath,
      '-vcodec', 'libx264',
      '-preset', 'veryfast',
      '-pix_fmt', 'yuv420p',
      '-movflags', '+faststart',
      '-an',
      '-y',
      finalPath,
    ];

    const ffmpeg = spawn(ffmpegPath, args);
    let stderr = '';

    ffmpeg.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    ffmpeg.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`ffmpeg transcode failed (exit ${code}): ${stderr.slice(-500)}`));
      }
    });

    ffmpeg.on('error', (err) => reject(new Error(`Failed to start ffmpeg: ${err.message}`)));
  });
}

function buildTrackerArgs(inputPath, outputVideoRaw, outputCsv, outputEvents, overrides = {}) {
  // Parse & clamp per-run settings from the Settings UI. Empty/invalid values
  // fall back to TRACKER_DEFAULTS so a missing payload still yields pitch-identical output.
  const num = (v, fallback) => {
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? n : fallback;
  };
  const cfg = {
    minArea: num(overrides.minArea, TRACKER_DEFAULTS.minArea),
    maxArea: num(overrides.maxArea, TRACKER_DEFAULTS.maxArea),
    proximityThreshold: num(overrides.proximityThreshold, TRACKER_DEFAULTS.proximityThreshold),
    boutMinFrames: Math.max(1, Math.floor(num(overrides.boutMinFrames, TRACKER_DEFAULTS.boutMinFrames))),
  };
  return [
    trackerScript,
    '--input', inputPath,
    '--output-video', outputVideoRaw,
    '--output-csv', outputCsv,
    '--output-events', outputEvents,
    '--min-area', String(cfg.minArea),
    '--max-area', String(cfg.maxArea),
    '--proximity-threshold', String(cfg.proximityThreshold),
    '--bout-min-frames', String(cfg.boutMinFrames),
  ];
}

function startTracking(inputPath, overrides = {}) {
  const outputVideoRaw = path.join(publicDir, 'tracked_raw.mp4');
  const outputVideoFinal = path.join(publicDir, 'tracked.mp4');
  const outputCsv = path.join(publicDir, 'data.csv');
  const outputEvents = EVENTS_PATH;

  job.status = 'processing';
  job.progress = 'Initializing tracker pipeline...';
  job.framesProcessed = 0;
  job.startTime = Date.now();
  job.error = null;
  trackerStdout = '';
  job.overrides = overrides; // echo back to UI for transparency

  console.log(`[Server] Starting tracker on: ${inputPath}`);
  console.log(`[Server] Tracker config: ${JSON.stringify(overrides)}`);

  const tracker = spawn(pythonExe, buildTrackerArgs(inputPath, outputVideoRaw, outputCsv, outputEvents, overrides));

  activeTracker = tracker;

  tracker.stdout.on('data', (data) => {
    const msg = data.toString().trim();
    trackerStdout += data.toString();
    console.log(`[Tracker] ${msg}`);

    const match = msg.match(/Processed (\d+) frames/);
    if (match) {
      job.framesProcessed = parseInt(match[1]);
      job.progress = `Processed ${job.framesProcessed} frames...`;
    } else if (msg.includes('Tracking completed')) {
      job.progress = 'Finalizing output files...';
    } else {
      job.progress = msg;
    }
  });

  tracker.stderr.on('data', (data) => {
    const msg = data.toString().trim();
    trackerStdout += data.toString();
    if (msg.includes('NAL unit') || msg.includes('partial file')) {
      console.log(`[Tracker] (codec warning, safe to ignore) ${msg}`);
    } else {
      console.error(`[Tracker] ${msg}`);
    }
  });

  tracker.on('close', async (code) => {
    activeTracker = null;
    job.endTime = Date.now();
    const elapsed = ((job.endTime - job.startTime) / 1000).toFixed(1);

    if (code !== 0) {
      job.status = 'error';
      job.error = `Tracker exited with code ${code}`;
      job.progress = '';
      console.error(`[Server] ❌ Tracker failed with code ${code}`);
      return;
    }

    try {
      const syncInfo = parseTrackerSync(trackerStdout);
      const csvRows = countCsvRows(outputCsv);
      let videoFrames = null;

      if (fs.existsSync(outputVideoRaw)) {
        videoFrames = await getVideoFrameCount(outputVideoRaw);
      }

      const frameCount = syncInfo?.framesProcessed ?? csvRows;
      const syncOk = syncInfo?.syncOk !== false
        && csvRows === frameCount
        && (videoFrames === null || videoFrames === csvRows);

      const eventsFps = readEventsFps();
      const metadata = {
        framesProcessed: frameCount,
        csvRows,
        videoFrames,
        expectedVideoFrames: syncInfo?.expectedVideoFrames ?? null,
        syncOk,
        fps: eventsFps,
        timestamp: new Date().toISOString(),
      };
      writeRunMetadata(metadata);
      job.frameCount = frameCount;

      console.log(
        `[Server] Frame sync: csv_rows=${csvRows}, video_frames=${videoFrames}, sync_ok=${syncOk}`
      );

      if (!syncOk) {
        throw new Error(
          `Frame sync mismatch (csv=${csvRows}, video=${videoFrames}, tracker=${frameCount})`
        );
      }

      // Snapshot this run's CSV + events into history BEFORE touching video files.
      try {
        snapshotRunToHistory({
          runId: job.runId,
          filename: job.uploadedFilename,
          durationSec: parseFloat(elapsed),
          fps: eventsFps,
          totalFrames: frameCount,
        });
        console.log(`[Server] 📚 Run snapshotted to history`);
      } catch (histErr) {
        console.error(`[Server] History snapshot failed (non-fatal): ${histErr.message}`);
      }

      if (!fs.existsSync(outputVideoRaw)) {
        throw new Error('tracked_raw.mp4 missing after tracker completed');
      }

      job.progress = 'Transcoding video for browser playback...';
      await transcodeVideo(outputVideoRaw, outputVideoFinal);

      fs.unlinkSync(outputVideoRaw);
      console.log(`[Server] Transcoded annotated video to ${outputVideoFinal}`);

      job.status = 'done';
      job.progress = `Tracking complete! Processed ${job.framesProcessed} frames in ${elapsed}s`;
      console.log(`[Server] ✅ Tracking completed in ${elapsed}s`);
    } catch (e) {
      job.status = 'error';
      job.error = e.message;
      job.progress = '';
      console.error(`[Server] ❌ Post-processing failed: ${e.message}`);
      console.error('[Server] CSV may still be valid at public/data.csv');
    }
  });

  tracker.on('error', (err) => {
    activeTracker = null;
    job.status = 'error';
    job.error = `Failed to start tracker: ${err.message}`;
    job.progress = '';
    console.error(`[Server] ❌ ${err.message}`);
  });
}

// ============================================================
// ROUTES
// ============================================================

app.get('/api/status', (req, res) => {
  res.json({ ...job });
});

app.post('/api/upload', upload.single('video'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No video file provided' });
  }

  if (job.status === 'processing') {
    return res.status(409).json({ error: 'A video is already being processed. Please wait.' });
  }

  resetJob();
  resetVerification();
  runId += 1;
  const currentRunId = runId;
  job.runId = currentRunId;
  job.status = 'uploading';
  job.progress = 'Video uploaded, starting tracker...';
  job.uploadedFilename = req.file.originalname;

  // Per-run Settings overrides (multipart text fields arrive as strings).
  // buildTrackerArgs validates/clamps these; invalid → TRACKER_DEFAULTS.
  const overrides = {
    minArea: req.body.minArea,
    maxArea: req.body.maxArea,
    proximityThreshold: req.body.proximityThreshold,
    boutMinFrames: req.body.boutMinFrames,
  };

  const inputPath = req.file.path;
  const uploadedFilename = req.file.originalname;
  console.log(`[Server] Received upload: ${uploadedFilename} (${(req.file.size / 1024 / 1024).toFixed(1)} MB)`);

  res.json({ success: true, message: 'Upload received, processing started', runId: currentRunId });

  startTracking(inputPath, overrides);
});

app.post('/api/reset', (req, res) => {
  resetJob();
  res.json({ success: true });
});

app.get('/api/events', (req, res) => {
  if (!fs.existsSync(EVENTS_PATH)) {
    return res.status(404).json({ error: 'No events file found. Run tracking first.' });
  }
  try {
    const eventsData = JSON.parse(fs.readFileSync(EVENTS_PATH, 'utf8'));
    res.json(eventsData);
  } catch (e) {
    res.status(500).json({ error: `Failed to read events: ${e.message}` });
  }
});

app.get('/api/verification', (req, res) => {
  res.json(readVerification());
});

app.post('/api/verification', (req, res) => {
  const { eventId, verdict } = req.body || {};
  if (!eventId || !['confirmed', 'rejected'].includes(verdict)) {
    return res.status(400).json({ error: 'Body must include eventId and verdict (confirmed|rejected)' });
  }

  const data = readVerification();
  const existing = data.reviews.findIndex((r) => r.event_id === eventId);
  const review = {
    event_id: eventId,
    verdict,
    reviewed_at: new Date().toISOString(),
  };

  if (existing >= 0) {
    data.reviews[existing] = review;
  } else {
    data.reviews.push(review);
  }

  writeVerification(data);
  res.json({ success: true, review });
});

app.post('/api/verification/reset', (req, res) => {
  resetVerification();
  res.json({ success: true });
});

// ---- Run history (Task E / K-06) ----
// Per-run CSV + events live under public/history/<runId>/ and are served
// statically by express.static(publicDir) already mounted via Vite proxy.
// These routes expose metadata + convenience loaders.

app.get('/api/history', (req, res) => {
  res.json(readHistoryMeta());
});

app.delete('/api/history', (req, res) => {
  // Clear metadata only; leave snapshot files on disk (cheap, recoverable).
  writeHistoryMeta({ version: 1, runs: [] });
  res.json({ success: true });
});

app.get('/api/history/:runId', (req, res) => {
  const { runId } = req.params;
  const meta = readHistoryMeta();
  const entry = meta.runs.find((r) => r.runId === runId);
  if (!entry) return res.status(404).json({ error: 'Run not found' });
  res.json(entry);
});

app.listen(PORT, () => {
  console.log(`\n  🧬 Flyt API Server`);
  console.log(`  ➜  Running on http://localhost:${PORT}`);
  console.log(`  ➜  Tracker: ${trackerScript}`);
  console.log(`  ➜  Python:  ${pythonExe}`);
  console.log(`  ➜  FFmpeg:  ${ffmpegPath}\n`);
});