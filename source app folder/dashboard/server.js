import { randomUUID } from 'crypto';
import { spawn as nodeSpawn } from 'child_process';
import express from 'express';
import defaultFfmpegPath from 'ffmpeg-static';
import fs from 'fs';
import multer from 'multer';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  AbortRunError,
  assertEventBelongsToRun,
  buildTrackerArgs,
  createRunId,
  countCsvRows,
  ensureDir,
  getVideoFrameCount,
  parseTrackerSync,
  prepareRunHistoryBundle,
  publishBundle,
  readEventsFps,
  readJson,
  recoverPublishArtifacts,
  recoverRuntimeArtifacts,
  resolveVerificationPath,
  scopeEventsForRun,
  runCommand,
  safeRemoveDir,
  safeUnlink,
  verificationPathForRun,
  terminateChild,
  transcodeVideo,
  validateFrameIntegrity,
  writeJson,
} from './server-utils.js';

const modulePath = fileURLToPath(import.meta.url);
const moduleDir = path.dirname(modulePath);
const DEFAULT_PORT = 3001;
const DEFAULT_ALLOWED_ORIGINS = [
  'http://localhost:3001',
  'http://127.0.0.1:3001',
  'http://localhost:5173',
  'http://127.0.0.1:5173',
];

function blankJob() {
  return {
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

function parseAllowedOrigins(value) {
  if (!value) return DEFAULT_ALLOWED_ORIGINS;
  return value.split(',').map((item) => item.trim()).filter(Boolean);
}

export function createFlytServer(options = {}) {
  const rootDir = options.rootDir || moduleDir;
  const uploadsDir = options.uploadsDir || path.join(rootDir, 'uploads');
  const publicDir = options.publicDir || path.join(rootDir, 'public');
  const historyDir = options.historyDir || path.join(publicDir, 'history');
  const historyMetaPath = options.historyMetaPath || path.join(publicDir, 'history.json');
  const verificationPath = options.verificationPath || path.join(publicDir, 'verification.json');
  const trackerDir = options.trackerDir || path.join(rootDir, '..', 'tracker');
  const trackerScript = options.trackerScript || path.join(trackerDir, 'tracker.py');
  const isWindows = process.platform === 'win32';
  const pythonExe = options.pythonExe || path.join(
    trackerDir,
    'venv',
    isWindows ? 'Scripts' : 'bin',
    isWindows ? 'python.exe' : 'python',
  );
  const ffmpegPath = options.ffmpegPath || defaultFfmpegPath;
  const spawnFn = options.spawnFn || nodeSpawn;
  const defaults = options.defaults || {
    minArea: 30,
    maxArea: 0,
    proximityThreshold: 60,
    boutMinFrames: 90,
  };
  const allowedOrigins = new Set(options.allowedOrigins || parseAllowedOrigins(process.env.FLYT_ALLOWED_ORIGINS));
  const killOptions = options.killOptions || { graceMs: 1000, hardKillMs: 3000 };

  for (const dir of [uploadsDir, publicDir, historyDir]) ensureDir(dir);
  recoverRuntimeArtifacts(uploadsDir);
  recoverPublishArtifacts(publicDir);

  const app = express();
  const storage = multer.diskStorage({
    destination: (_req, _file, callback) => callback(null, uploadsDir),
    filename: (req, file, callback) => {
      const filename = `input-${Date.now()}-${randomUUID()}${path.extname(file.originalname).toLowerCase()}`;
      const state = pendingUploads.get(req);
      if (state) state.filePath = path.join(uploadsDir, filename);
      callback(null, filename);
    },
  });
  const upload = multer({ storage, limits: { fileSize: 10 * 1024 * 1024 * 1024 } });

  app.use(express.json());
  app.use((req, res, next) => {
    const origin = req.get('Origin');
    if (!origin) return next();
    if (!allowedOrigins.has(origin)) {
      return res.status(403).json({ error: 'Cross-origin request denied.' });
    }
    res.header('Access-Control-Allow-Origin', origin);
    res.header('Vary', 'Origin');
    res.header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    return next();
  });

  let epoch = 0;
  let uploadReserved = false;
  let terminating = false;
  let activeRun = null;
  let job = blankJob();
  const pendingUploads = new Map();

  const services = {
    countFrames: options.services?.countFrames || ((filePath, context) => getVideoFrameCount(
      ffmpegPath,
      filePath,
      {
        spawnFn,
        signal: context.controller.signal,
        children: context.children,
        killOptions,
      },
    )),
    runTracker: options.services?.runTracker || ((inputPath, outputs, overrides, context) => runCommand(
      pythonExe,
      buildTrackerArgs(trackerScript, inputPath, outputs, overrides, defaults),
      {
        spawnFn,
        signal: context.controller.signal,
        children: context.children,
        killOptions,
        onStdout: (text) => {
          const match = text.match(/Processed (\d+) frames/);
          if (match && isCurrent(context)) {
            job.framesProcessed = Number(match[1]);
            job.progress = `Processed ${job.framesProcessed} frames...`;
          } else if (text.includes('Tracking completed') && isCurrent(context)) {
            job.progress = 'Validating tracker output...';
          }
        },
        onStderr: (text) => console.error(`[Tracker] ${text.trim()}`),
      },
    )),
    transcode: options.services?.transcode || ((rawPath, finalPath, context) => transcodeVideo(
      ffmpegPath,
      rawPath,
      finalPath,
      {
        spawnFn,
        signal: context.controller.signal,
        children: context.children,
        killOptions,
      },
    )),
    publish: options.services?.publish || ((entries, token) => publishBundle(
      entries, token, { manifestDir: publicDir },
    )),
    prepareHistory: options.services?.prepareHistory || prepareRunHistoryBundle,
  };

  const isBusy = () => (
    uploadReserved
    || terminating
    || ['uploading', 'processing', 'stopping'].includes(job.status)
  );
  const isCurrent = (context) => (
    activeRun === context
    && context.epoch === epoch
    && !context.controller.signal.aborted
  );

  function reserveUpload(req, res, next) {
    if (isBusy()) {
      return res.status(409).json({ error: 'A video is already uploading, processing, or stopping.' });
    }
    req.uploadEpoch = epoch;
    uploadReserved = true;
    let released = false;
    let resolveClosed;
    const state = {
      request: req,
      filePath: null,
      closed: new Promise((resolve) => { resolveClosed = resolve; }),
      release: null,
    };
    const release = () => {
      if (released) return;
      released = true;
      pendingUploads.delete(req);
      uploadReserved = pendingUploads.size > 0;
    };
    state.release = release;
    pendingUploads.set(req, state);
    req.once('close', () => resolveClosed());
    res.once('finish', release);
    res.once('close', release);
    return next();
  }

  function readVerification(filePath) {
    const data = readJson(filePath, { version: 1, reviews: [] });
    return Array.isArray(data.reviews) ? data : { version: 1, reviews: [] };
  }

  function waitForUploadClose(state) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Multipart upload did not close after reset')), 3000);
      timer.unref?.();
      state.closed.then(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  async function removePendingUploadFile(filePath) {
    if (!filePath) return;
    let lastError = null;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        fs.rmSync(filePath, { force: true });
        if (!fs.existsSync(filePath)) return;
        lastError = new Error(`Could not remove cancelled upload: ${filePath}`);
      } catch (error) {
        lastError = error;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw lastError || new Error(`Could not remove cancelled upload: ${filePath}`);
  }

  async function abortPendingUploads(states) {
    states.forEach((state) => {
      if (!state.request.destroyed) state.request.destroy();
    });
    await Promise.all(states.map(async (state) => {
      await waitForUploadClose(state);
      await removePendingUploadFile(state.filePath);
      state.release();
    }));
  }

  async function stopActiveRun() {
    epoch += 1;
    const context = activeRun;
    const uploadStates = [...pendingUploads.values()];
    activeRun = null;
    const hasWork = Boolean(context) || uploadStates.length > 0;
    job = { ...blankJob(), status: hasWork ? 'stopping' : 'idle' };
    if (!hasWork) return;

    terminating = true;
    context?.controller.abort();
    let stoppedCleanly = false;
    try {
      const children = context ? [...context.children] : [];
      await Promise.all([
        abortPendingUploads(uploadStates),
        ...children.map((child) => terminateChild(child, killOptions)),
      ]);
      if (context) {
        await context.done.catch((error) => {
          if (error?.name !== 'AbortError') throw error;
        });
      }
      job = blankJob();
      stoppedCleanly = true;
    } catch (error) {
      job = {
        ...blankJob(),
        status: 'error',
        error: `Could not terminate active work: ${error.message}`,
      };
      throw error;
    } finally {
      if (
        stoppedCleanly
        && (!context || context.children.size === 0)
        && pendingUploads.size === 0
      ) terminating = false;
    }
  }

  function createRunContext(inputPath, filename, overrides) {
    const runId = createRunId();
    const runEpoch = epoch;
    const token = `${runId}-${runEpoch}-${randomUUID()}`;
    const workDir = path.join(uploadsDir, `run-${token}`);
    ensureDir(workDir);
    return {
      runId,
      epoch: runEpoch,
      token,
      workDir,
      inputPath,
      filename,
      overrides,
      startedAt: Date.now(),
      controller: new AbortController(),
      children: new Set(),
      done: null,
    };
  }

  async function executeRun(context) {
    const outputs = {
      rawVideo: path.join(context.workDir, 'tracked_raw.mp4'),
      browserVideo: path.join(context.workDir, 'tracked.mp4'),
      csv: path.join(context.workDir, 'data.csv'),
      events: path.join(context.workDir, 'events.json'),
      metadata: path.join(context.workDir, 'run_metadata.json'),
      verification: path.join(context.workDir, 'verification.json'),
      historyIndex: path.join(context.workDir, 'history.json'),
    };
    const ensureCurrent = () => {
      if (!isCurrent(context)) throw new AbortRunError();
    };

    try {
      job.status = 'processing';
      job.progress = 'Counting input frames...';
      const inputFrames = await services.countFrames(context.inputPath, context);
      ensureCurrent();

      job.progress = 'Running tracker...';
      const trackerResult = await services.runTracker(
        context.inputPath,
        outputs,
        context.overrides,
        context,
      );
      ensureCurrent();
      if (trackerResult.code !== 0) {
        throw new Error(`Tracker exited with code ${trackerResult.code}: ${trackerResult.stderr.slice(-500)}`);
      }

      const syncInfo = parseTrackerSync(trackerResult.stdout);
      if (!syncInfo) throw new Error('Frame integrity evidence missing: TRACKER_SYNC marker required');
      if (!fs.existsSync(outputs.csv)) throw new Error('Tracker data.csv missing');
      if (!fs.existsSync(outputs.rawVideo)) throw new Error('Tracker raw video missing');
      if (!fs.existsSync(outputs.events)) throw new Error('Tracker events.json missing');

      const csvRows = countCsvRows(outputs.csv);
      job.progress = 'Counting raw output frames...';
      const rawVideoFrames = await services.countFrames(outputs.rawVideo, context);
      ensureCurrent();

      job.progress = 'Transcoding browser video...';
      await services.transcode(outputs.rawVideo, outputs.browserVideo, context);
      ensureCurrent();

      job.progress = 'Counting final output frames...';
      const finalVideoFrames = await services.countFrames(outputs.browserVideo, context);
      ensureCurrent();

      const integrity = validateFrameIntegrity({
        syncInfo,
        inputFrames,
        csvRows,
        rawVideoFrames,
        finalVideoFrames,
      });
      const fps = readEventsFps(outputs.events);
      scopeEventsForRun(outputs.events, context.runId, outputs.events);
      const metadata = {
        ...integrity,
        runId: context.runId,
        expectedVideoFrames: syncInfo.expectedVideoFrames,
        fps,
        timestamp: new Date().toISOString(),
      };
      writeJson(outputs.metadata, metadata);
      writeJson(outputs.verification, { version: 1, run_id: context.runId, reviews: [] });
      const historyBundle = services.prepareHistory({
        runId: context.runId,
        historyDir,
        historyMetaPath,
        historyIndexOutput: outputs.historyIndex,
        filename: context.filename,
        durationSec: (Date.now() - context.startedAt) / 1000,
        fps,
        totalFrames: integrity.inputFrames,
        csvSrc: outputs.csv,
        eventsSrc: outputs.events,
        verificationSrc: outputs.verification,
      });
      ensureCurrent();

      job.progress = 'Publishing validated current and historical results...';
      services.publish([
        { source: outputs.csv, destination: path.join(publicDir, 'data.csv') },
        { source: outputs.events, destination: path.join(publicDir, 'events.json') },
        { source: outputs.browserVideo, destination: path.join(publicDir, 'tracked.mp4') },
        { source: outputs.metadata, destination: path.join(publicDir, 'run_metadata.json') },
        ...historyBundle.entries,
      ], context.token);
      ensureCurrent();

      job = {
        ...job,
        frameCount: integrity.inputFrames,
        framesProcessed: integrity.inputFrames,
        totalFrames: integrity.inputFrames,
        status: 'done',
        progress: `Tracking complete! Processed ${integrity.inputFrames} frames.`,
        endTime: Date.now(),
      };
    } catch (error) {
      if (isCurrent(context)) {
        job = {
          ...job,
          status: 'error',
          progress: '',
          error: error.message,
          endTime: Date.now(),
        };
      }
      if (error?.name !== 'AbortError') console.error(`[Server] Run failed: ${error.message}`);
      throw error;
    } finally {
      safeUnlink(context.inputPath);
      safeRemoveDir(context.workDir);
      if (activeRun === context && context.children.size === 0) activeRun = null;
    }
  }

  app.get('/api/status', (_req, res) => res.json({ ...job }));

  app.post('/api/upload', reserveUpload, upload.single('video'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No video file provided' });
    if (req.uploadEpoch !== epoch) {
      safeUnlink(req.file.path);
      return res.status(409).json({ error: 'Upload was cancelled by a reset.' });
    }
    const overrides = {
      minArea: req.body.minArea,
      maxArea: req.body.maxArea,
      proximityThreshold: req.body.proximityThreshold,
      boutMinFrames: req.body.boutMinFrames,
    };
    const context = createRunContext(req.file.path, req.file.originalname, overrides);
    activeRun = context;
    job = {
      ...blankJob(),
      runId: context.runId,
      status: 'uploading',
      progress: 'Upload complete. Starting validation pipeline...',
      uploadedFilename: context.filename,
      startTime: context.startedAt,
    };
    context.done = executeRun(context).catch(() => {});
    return res.json({ success: true, runId: context.runId });
  });

  app.post('/api/reset', async (_req, res) => {
    try {
      await stopActiveRun();
      return res.json({ success: true });
    } catch (error) {
      return res.status(500).json({ error: error.message });
    }
  });

  app.get('/api/events', (_req, res) => {
    const data = readJson(path.join(publicDir, 'events.json'), null);
    if (!data) return res.status(404).json({ error: 'No events file found.' });
    return res.json(data);
  });

  function currentRunId() {
    return readJson(path.join(publicDir, 'run_metadata.json'), null)?.runId || null;
  }

  app.get('/api/verification', (req, res) => {
    const runId = req.query.runId || currentRunId();
    if (!runId) return res.status(404).json({ error: 'No current run found' });
    try {
      return res.json(readVerification(verificationPathForRun(runId, historyDir)));
    } catch (error) {
      return res.status(404).json({ error: error.message });
    }
  });

  app.post('/api/verification', (req, res) => {
    const { eventId, verdict } = req.body || {};
    if (!eventId || !['confirmed', 'rejected'].includes(verdict)) {
      return res.status(400).json({ error: 'Body must include eventId and verdict.' });
    }
    try {
      assertEventBelongsToRun(eventId, historyDir);
      const filePath = resolveVerificationPath(eventId, historyDir);
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

  app.post('/api/verification/reset', (req, res) => {
    const runId = req.body?.runId || currentRunId();
    if (!runId) return res.status(404).json({ error: 'No current run found' });
    try {
      writeJson(verificationPathForRun(runId, historyDir), { version: 1, run_id: runId, reviews: [] });
      return res.json({ success: true });
    } catch (error) {
      return res.status(404).json({ error: error.message });
    }
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

  return {
    app,
    stop: stopActiveRun,
    getState: () => ({
      epoch,
      uploadReserved,
      terminating,
      pendingUploads: pendingUploads.size,
      activeRun,
      job: { ...job },
    }),
    paths: { uploadsDir, publicDir, historyDir, historyMetaPath, verificationPath },
  };
}

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(modulePath);
if (isDirectRun) {
  const { app } = createFlytServer();
  app.listen(DEFAULT_PORT, () => {
    console.log(`\n  🧬 Flyt API Server\n  ➜  http://localhost:${DEFAULT_PORT}`);
  });
}
