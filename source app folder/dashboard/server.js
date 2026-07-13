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
  appendStageLog,
  assertEventBelongsToRun,
  buildTrackerArgs,
  createLineBuffer,
  createRunId,
  countCsvRows,
  ensureDir,
  getVideoFrameCount,
  parseProcessedFramesLine,
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
  summarizeTrackingValidityFromCsv,
  toClientErrorMessage,
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
    uploadedFilename: null,
    stageLog: [],
    resultPublished: false,
    durationMs: null,
    integrity: null,
    trackingValidity: null,
  };
}

function jobDurationMs(jobState, now = Date.now()) {
  if (!jobState?.startTime) return null;
  if (jobState.endTime) return Math.max(0, jobState.endTime - jobState.startTime);
  return Math.max(0, now - jobState.startTime);
}

function withLiveTiming(jobState) {
  const durationMs = jobDurationMs(jobState);
  return {
    ...jobState,
    stageLog: Array.isArray(jobState.stageLog) ? [...jobState.stageLog] : [],
    durationMs,
    elapsedMs: durationMs,
  };
}

function pushStage(jobState, entry, isCurrentFn) {
  if (!Array.isArray(jobState.stageLog)) jobState.stageLog = [];
  return appendStageLog(jobState.stageLog, entry, { isCurrent: isCurrentFn });
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
  let stoppingRun = null;
  let job = blankJob();
  const pendingUploads = new Map();
  const observedStoppingChildren = new WeakSet();

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
    runTracker: options.services?.runTracker || ((inputPath, outputs, overrides, context) => {
      const lineBuffer = createLineBuffer((line) => {
        if (!isCurrent(context)) return;
        const frames = parseProcessedFramesLine(line);
        if (frames !== null) {
          job.framesProcessed = frames;
          const total = job.totalFrames;
          const pct = Number.isFinite(total) && total > 0
            ? Math.min(100, Math.round((frames / total) * 100))
            : null;
          job.progress = pct !== null
            ? `Processed ${frames} / ${total} frames (${pct}%)`
            : `Processed ${frames} frames...`;
          pushStage(job, {
            stage: 'tracker_progress',
            message: job.progress,
            frames,
            total: Number.isFinite(total) ? total : undefined,
          }, () => isCurrent(context));
          return;
        }
        if (/tracking completed/i.test(line)) {
          job.progress = 'Validating tracker output...';
          pushStage(job, {
            stage: 'tracker_validating',
            message: 'Tracker finished; validating output...',
          }, () => isCurrent(context));
        }
      });
      // -u + PYTHONUNBUFFERED: force line-level progress through the pipe so
      // the dashboard can show live framesProcessed instead of a final jump.
      return runCommand(
        pythonExe,
        ['-u', ...buildTrackerArgs(trackerScript, inputPath, outputs, overrides, defaults)],
        {
          spawnFn,
          signal: context.controller.signal,
          children: context.children,
          killOptions,
          env: { ...process.env, PYTHONUNBUFFERED: '1' },
          onStdout: (text) => lineBuffer.push(text),
          onStderr: (text) => console.error(`[Tracker] ${text.trim()}`),
        },
      ).finally(() => lineBuffer.flush());
    }),
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

  function reconcileStoppingState() {
    const context = stoppingRun;
    const contextFinished = !context || context.finished;
    const childrenStopped = !context || context.children.size === 0;
    if (!terminating || !contextFinished || !childrenStopped || pendingUploads.size > 0) {
      return false;
    }

    stoppingRun = null;
    terminating = false;
    if (
      job.status === 'stopping'
      || (job.status === 'error' && job.error?.startsWith('Could not terminate active work:'))
    ) {
      job = blankJob();
    }
    return true;
  }

  function observeStoppingChildren(context) {
    if (!context) return;
    context.children.forEach((child) => {
      if (observedStoppingChildren.has(child)) return;
      observedStoppingChildren.add(child);
      child.once('close', () => queueMicrotask(reconcileStoppingState));
    });
  }

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
      queueMicrotask(reconcileStoppingState);
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
    const uploadStates = [...pendingUploads.values()];
    const context = activeRun || stoppingRun;
    if (activeRun || uploadStates.length > 0) epoch += 1;
    if (activeRun) stoppingRun = activeRun;
    activeRun = null;

    const hasWork = Boolean(context) || uploadStates.length > 0;
    job = { ...blankJob(), status: hasWork ? 'stopping' : 'idle' };
    if (!hasWork) {
      reconcileStoppingState();
      return;
    }

    terminating = true;
    context?.controller.abort();
    observeStoppingChildren(context);
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
    } catch (error) {
      job = {
        ...blankJob(),
        status: 'error',
        error: `Could not terminate active work: ${error.message}`,
      };
      throw error;
    } finally {
      reconcileStoppingState();
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
      finished: false,
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
    const stage = (entry) => pushStage(job, entry, () => isCurrent(context));

    try {
      job.status = 'processing';
      job.progress = 'Counting input frames...';
      stage({ stage: 'count_input', message: 'Counting input frames...' });
      const inputFrames = await services.countFrames(context.inputPath, context);
      ensureCurrent();
      job.totalFrames = inputFrames;
      job.progress = `Input frames counted: ${inputFrames}. Starting tracker...`;
      stage({
        stage: 'input_counted',
        message: `Input frames: ${inputFrames}`,
        total: inputFrames,
      });

      job.progress = 'Running tracker...';
      stage({ stage: 'tracker_started', message: 'Tracker started', total: inputFrames });
      const trackerResult = await services.runTracker(
        context.inputPath,
        outputs,
        context.overrides,
        context,
      );
      ensureCurrent();
      if (trackerResult.code !== 0) {
        // Keep detailed stderr in server logs only.
        console.error(`[Tracker] exit ${trackerResult.code}: ${String(trackerResult.stderr || '').slice(-2000)}`);
        throw new Error(`Tracker exited with code ${trackerResult.code}`);
      }

      const syncInfo = parseTrackerSync(trackerResult.stdout);
      if (!syncInfo) throw new Error('Frame integrity evidence missing: TRACKER_SYNC marker required');
      if (!fs.existsSync(outputs.csv)) throw new Error('Tracker data.csv missing');
      if (!fs.existsSync(outputs.rawVideo)) throw new Error('Tracker raw video missing');
      if (!fs.existsSync(outputs.events)) throw new Error('Tracker events.json missing');

      job.framesProcessed = syncInfo.framesProcessed;
      job.progress = 'Validating tracker output...';
      stage({
        stage: 'tracker_completed',
        message: `Tracker completed (${syncInfo.framesProcessed} frames)`,
        frames: syncInfo.framesProcessed,
        total: inputFrames,
      });

      const csvRows = countCsvRows(outputs.csv);
      job.progress = 'Counting raw output frames...';
      stage({ stage: 'count_raw', message: 'Counting raw output frames...' });
      const rawVideoFrames = await services.countFrames(outputs.rawVideo, context);
      ensureCurrent();
      stage({
        stage: 'raw_counted',
        message: `Raw video frames: ${rawVideoFrames}`,
        frames: rawVideoFrames,
      });

      job.progress = 'Transcoding browser video...';
      stage({ stage: 'transcoding', message: 'H.264 transcoding browser video...' });
      await services.transcode(outputs.rawVideo, outputs.browserVideo, context);
      ensureCurrent();
      stage({ stage: 'transcoded', message: 'H.264 transcode complete' });

      job.progress = 'Counting final output frames...';
      stage({ stage: 'count_final', message: 'Counting final H.264 frames...' });
      const finalVideoFrames = await services.countFrames(outputs.browserVideo, context);
      ensureCurrent();
      stage({
        stage: 'final_counted',
        message: `Final video frames: ${finalVideoFrames}`,
        frames: finalVideoFrames,
      });

      const integrity = validateFrameIntegrity({
        syncInfo,
        inputFrames,
        csvRows,
        rawVideoFrames,
        finalVideoFrames,
      });
      const fps = readEventsFps(outputs.events);
      scopeEventsForRun(outputs.events, context.runId, outputs.events);
      const trackingValidity = summarizeTrackingValidityFromCsv(outputs.csv);
      const completedAt = Date.now();
      const durationMs = completedAt - context.startedAt;
      const integritySummary = {
        passed: true,
        inputFrames: integrity.inputFrames,
        trackerFrames: integrity.trackerFrames,
        csvRows: integrity.csvRows,
        rawVideoFrames: integrity.rawVideoFrames,
        finalVideoFrames: integrity.finalVideoFrames,
        syncOk: integrity.syncOk,
      };
      stage({ stage: 'integrity_passed', message: 'Frame integrity passed' });

      const metadata = {
        ...integrity,
        runId: context.runId,
        expectedVideoFrames: syncInfo.expectedVideoFrames,
        fps,
        timestamp: new Date(completedAt).toISOString(),
        filename: context.filename,
        startTime: context.startedAt,
        endTime: completedAt,
        durationMs,
        stageLog: Array.isArray(job.stageLog) ? [...job.stageLog] : [],
        frameIntegrity: integritySummary,
        trackingValidity,
        resultPublished: true,
      };
      writeJson(outputs.metadata, metadata);
      writeJson(outputs.verification, { version: 1, run_id: context.runId, reviews: [] });
      const historyBundle = services.prepareHistory({
        runId: context.runId,
        historyDir,
        historyMetaPath,
        historyIndexOutput: outputs.historyIndex,
        filename: context.filename,
        durationSec: durationMs / 1000,
        fps,
        totalFrames: integrity.inputFrames,
        csvSrc: outputs.csv,
        eventsSrc: outputs.events,
        verificationSrc: outputs.verification,
        metadataSrc: outputs.metadata,
        trackingValidity,
        frameIntegrity: integritySummary,
        stageLog: metadata.stageLog,
        startTime: context.startedAt,
        endTime: completedAt,
      });
      ensureCurrent();

      job.progress = 'Publishing validated current and historical results...';
      stage({ stage: 'publishing', message: 'Publishing validated results...' });
      services.publish([
        { source: outputs.csv, destination: path.join(publicDir, 'data.csv') },
        { source: outputs.events, destination: path.join(publicDir, 'events.json') },
        { source: outputs.browserVideo, destination: path.join(publicDir, 'tracked.mp4') },
        { source: outputs.metadata, destination: path.join(publicDir, 'run_metadata.json') },
        ...historyBundle.entries,
      ], context.token);
      ensureCurrent();

      stage({ stage: 'completed', message: `Published run ${context.runId}` });
      // Best-effort: refresh published metadata with the final completed stage entry.
      // Primary metadata was already published transactionally above.
      try {
        metadata.stageLog = Array.isArray(job.stageLog) ? [...job.stageLog] : metadata.stageLog;
        const publishedMeta = path.join(publicDir, 'run_metadata.json');
        if (fs.existsSync(publishedMeta)) writeJson(publishedMeta, metadata);
        const historyMetaDest = path.join(historyDir, context.runId, 'run_metadata.json');
        if (fs.existsSync(historyMetaDest)) writeJson(historyMetaDest, metadata);
      } catch (metaRefreshError) {
        console.error(`[Server] Could not refresh run metadata log: ${metaRefreshError.message}`);
      }

      job = {
        ...job,
        frameCount: integrity.inputFrames,
        framesProcessed: integrity.inputFrames,
        totalFrames: integrity.inputFrames,
        status: 'done',
        progress: `Tracking complete! Processed ${integrity.inputFrames} frames.`,
        endTime: completedAt,
        durationMs,
        resultPublished: true,
        integrity: integritySummary,
        trackingValidity,
        uploadedFilename: context.filename,
      };
    } catch (error) {
      if (isCurrent(context)) {
        const endTime = Date.now();
        const clientError = error?.name === 'AbortError'
          ? 'Run was cancelled.'
          : toClientErrorMessage(error);
        pushStage(job, {
          stage: 'failed',
          message: clientError,
        }, () => isCurrent(context));
        job = {
          ...job,
          status: 'error',
          progress: '',
          error: clientError,
          endTime,
          durationMs: endTime - context.startedAt,
          resultPublished: false,
        };
      }
      if (error?.name !== 'AbortError') console.error(`[Server] Run failed: ${error.message}`);
      throw error;
    } finally {
      safeUnlink(context.inputPath);
      safeRemoveDir(context.workDir);
      context.finished = true;
      if (activeRun === context && context.children.size === 0) activeRun = null;
      reconcileStoppingState();
    }
  }

  app.get('/api/status', (_req, res) => res.json(withLiveTiming(job)));

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
      resultPublished: false,
      stageLog: [],
    };
    pushStage(job, {
      stage: 'accepted',
      message: `Upload accepted: ${context.filename}`,
    }, () => isCurrent(context));
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
      stoppingRun,
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
