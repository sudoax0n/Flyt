import React, { useState, useEffect, useRef, useCallback } from 'react';
import Papa from 'papaparse';
import { prismDistance, prismVelocity, proximityValue, summarizeTrackingValidity } from './metrics.js';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, AreaChart, Area,
  ScatterChart, Scatter, ZAxis,
} from 'recharts';
import {
  UploadCloud, Settings, Sun, Moon, X, Check, DownloadCloud, FileText, ChevronDown,
} from 'lucide-react';

const CHART_COLORS = {
  fly1: 'var(--chart-1)',
  fly2: 'var(--chart-2)',
  prox: 'var(--chart-ink)',
  grid: 'var(--chart-grid)',
  tick: 'var(--faint)',
};

// Lab notebook chart tooltip (compact, tabular)
const CustomTooltip = ({ active, payload, label }) => {
  if (active && payload && payload.length) {
    return (
      <div className="flyt-card" style={{ padding: '10px 12px', fontSize: 11, zIndex: 50 }}>
        <p style={{ margin: '0 0 6px', fontWeight: 650 }}>Frame {label}</p>
        <div style={{ display: 'grid', gap: 4 }}>
          {payload.map((entry, index) => (
            <p key={index} style={{ margin: 0, display: 'flex', justifyContent: 'space-between', gap: 12 }}>
              <span style={{ color: 'var(--muted)' }}>{entry.name ? entry.name.replace('_', ' ') : 'Value'}</span>
              <span className="flyt-mono" style={{ fontWeight: 600 }}>
                {typeof entry.value === 'number' ? entry.value.toFixed(1) : entry.value}
              </span>
            </p>
          ))}
        </div>
      </div>
    );
  }
  return null;
};

function formatRunDate(isoTimestamp) {
  if (!isoTimestamp) return 'Unknown date';
  return new Date(isoTimestamp).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function formatClock(sec) {
  if (!Number.isFinite(sec)) return '00:00';
  const s = Math.max(0, Math.floor(sec));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`;
}

function shortRunId(runId) {
  if (!runId) return 'n/a';
  const value = String(runId);
  if (value.length <= 22) return value;
  return `${value.slice(0, 12)}...${value.slice(-6)}`;
}

function formatDurationMs(ms) {
  if (!Number.isFinite(ms) || ms < 0) return 'n/a';
  const totalSec = Math.round(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  if (m <= 0) return `${s}s`;
  return `${m}m ${String(s).padStart(2, '0')}s`;
}

function formatStageTime(iso) {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleTimeString(undefined, {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  } catch {
    return '';
  }
}

function formatCount(n) {
  if (!Number.isFinite(n)) return 'n/a';
  return Number(n).toLocaleString();
}

function stageLabel(stage) {
  const map = {
    accepted: 'Input accepted',
    count_input: 'Counting input frames',
    input_counted: 'Input frames counted',
    tracker_started: 'Tracker started',
    tracker_progress: 'Tracking in progress',
    tracker_validating: 'Validating tracker output',
    tracker_completed: 'Tracking completed',
    count_raw: 'Counting raw output frames',
    raw_counted: 'Raw frames counted',
    transcoding: 'H.264 transcoding',
    transcoded: 'Transcode complete',
    count_final: 'Counting final frames',
    final_counted: 'Final frames counted',
    integrity_passed: 'Frame counts verified',
    publishing: 'Publishing results',
    completed: 'Results published',
    failed: 'Run failed',
  };
  return map[stage] || stage || 'Stage';
}

function stageCode(stage, integrityPassed) {
  if (stage === 'failed') return 'FAILED';
  if (stage === 'integrity_passed') return 'SYNC OK';
  if (stage === 'completed') return 'PUBLISHED';
  if (stage === 'tracker_progress') return 'RUNNING';
  if (integrityPassed && stage === 'integrity_passed') return 'SYNC OK';
  return 'COMPLETE';
}

function computeCourtshipStats(eventList, reviews) {
  const courtshipEvents = eventList.filter((e) => e.type === 'courtship_bout');
  const verified = courtshipEvents.filter(
    (e) => reviews[e.id]?.verdict === 'confirmed'
  ).length;
  return { detected: courtshipEvents.length, verified };
}

function eventTypeLabel(type) {
  if (type === 'courtship_bout') return 'Courtship bout';
  if (type === 'low_confidence_segment') return 'Low confidence';
  return type;
}

// Prism CSV exporter (Task D / K-07).
// Pivots the per-frame dataset into a column-oriented, GraphPad-Prism-friendly
// table: Time (sec), Fly1_Velocity, Fly2_Velocity, Distance (proximity).
// Prefers the new px/sec speed columns; falls back to px/frame if absent.
function exportPrismCsv(rows, fps) {
  const effectiveFps = fps > 0 ? fps : 30;
  const header = ['Time (sec)', 'Fly1_Velocity', 'Fly2_Velocity', 'Distance'];
  const csvEscape = (v) => {
    const s = String(v ?? '');
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [header.join(',')];
  rows.forEach((r) => {
    const t = Number(r.frame) / effectiveFps;
    const v1 = prismVelocity(r, 'fly1');
    const v2 = prismVelocity(r, 'fly2');
    const dist = prismDistance(r);
    lines.push([t, v1, v2, dist].map(csvEscape).join(','));
  });
  const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  a.href = url;
  a.download = `flyt_prism_${stamp}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function triggerPdfReport() {
  // Browser-native PDF via print pipeline. @media print rules in index.css
  // hide nav/sidebar/buttons and surface only the report content.
  window.print();
}

function RunLogPanel({ runProvenance, trackingValidity }) {
  if (!runProvenance) return null;
  const integrity = runProvenance.frameIntegrity || runProvenance.integrity;
  const validity = trackingValidity || runProvenance.trackingValidity;
  const stages = Array.isArray(runProvenance.stageLog) ? runProvenance.stageLog : [];
  const integrityPassed = integrity?.passed === true || integrity?.syncOk === true;

  return (
    <section className="flyt-record" id="record" aria-labelledby="record-title">
      <div className="flyt-section-head">
        <h2 className="flyt-h2" id="record-title">Run record</h2>
        <span className="flyt-muted flyt-mono" title={runProvenance.runId}>
          {shortRunId(runProvenance.runId)}
        </span>
      </div>

      <dl className="flyt-record-meta">
        <div>
          <dt>File</dt>
          <dd>{runProvenance.filename || 'n/a'}</dd>
        </div>
        <div>
          <dt>Completed</dt>
          <dd>{formatRunDate(runProvenance.timestamp || runProvenance.endTime)}</dd>
        </div>
        <div>
          <dt>Duration</dt>
          <dd>{formatDurationMs(runProvenance.durationMs)}</dd>
        </div>
        <div>
          <dt>Frame integrity</dt>
          <dd>{integrity ? (integrityPassed ? 'passed' : 'not passed') : 'not available'}</dd>
        </div>
        {integrity && (
          <div style={{ gridColumn: '1 / -1' }}>
            <dt>Frame counts</dt>
            <dd>
              input {formatCount(integrity.inputFrames)} · tracker {formatCount(integrity.trackerFrames)} · csv {formatCount(integrity.csvRows)} · raw {formatCount(integrity.rawVideoFrames)} · final {formatCount(integrity.finalVideoFrames)}
            </dd>
          </div>
        )}
        <div style={{ gridColumn: '1 / -1' }}>
          <dt>Tracking validity</dt>
          <dd>
            {validity?.available
              ? `${formatCount(validity.validFrames)} / ${formatCount(validity.totalFrames)} measured two-fly frames (${validity.percent}%)`
              : 'not available'}
          </dd>
        </div>
      </dl>
      <p className="flyt-muted" style={{ margin: '0 0 12px', fontSize: 11 }}>
        Tracking validity is the share of frames with two separate fly observations. It is not an accuracy score.
      </p>

      {stages.length > 0 ? (
        stages.map((entry, index) => (
          <div className="flyt-record-row" key={`${entry.t}-${entry.stage}-${index}`}>
            <time dateTime={entry.t}>{formatStageTime(entry.t)}</time>
            <div>
              <strong>{stageLabel(entry.stage)}</strong>
              <span>{entry.message || entry.stage}</span>
            </div>
            <code>{stageCode(entry.stage, integrityPassed)}</code>
          </div>
        ))
      ) : (
        <div className="flyt-record-row">
          <time>{formatStageTime(runProvenance.timestamp)}</time>
          <div>
            <strong>Published run</strong>
            <span>Stage log not stored for this record</span>
          </div>
          <code>LOADED</code>
        </div>
      )}
    </section>
  );
}

function DashboardView({
  data,
  stats,
  heatmapData,
  events,
  reviewsByEventId,
  runTimestamp,
  mediaCacheBust,
  runFps,
  totalFrames,
  activeEventId,
  isHistoricRun,
  runProvenance,
  videoAvailable,
  trackingValidity,
  onSeekEvent,
  onVerdict,
}) {
  const videoRef = useRef(null);
  const [playingEventId, setPlayingEventId] = useState(null);
  const [jumpFrameInput, setJumpFrameInput] = useState('');
  const [currentFrame, setCurrentFrame] = useState(0);
  const [showLowConfidence, setShowLowConfidence] = useState(false);

  if (!runProvenance?.runId) {
    return (
      <div className="flyt-empty flyt-card">
        <h3 className="flyt-serif">No tracking run loaded</h3>
        <p>
          Upload a video under <strong>New run</strong>, or open a prior dataset from <strong>History</strong>.
        </p>
      </div>
    );
  }

  const maxFrame = totalFrames > 0 ? totalFrames - 1 : 0;
  const fps = runFps > 0 ? runFps : 30;
  const visibleEvents = showLowConfidence
    ? events
    : events.filter((e) => e.type !== 'low_confidence_segment');
  const pendingCount = visibleEvents.filter((e) => !reviewsByEventId[e.id]?.verdict).length;
  const validity = trackingValidity || runProvenance.trackingValidity;
  const integrity = runProvenance.frameIntegrity || runProvenance.integrity;
  const integrityPassed = integrity?.passed === true || integrity?.syncOk === true;
  const frameTotal = totalFrames || data.length || 0;

  const handleVideoTimeUpdate = () => {
    const video = videoRef.current;
    if (video) setCurrentFrame(Math.round(video.currentTime * fps));
    if (!video || !events.length) {
      setPlayingEventId(null);
      return;
    }
    const t = video.currentTime;
    const active = events.find(
      (e) => t >= e.start_time_sec && t <= e.end_time_sec + 0.05
    );
    setPlayingEventId(active?.id ?? null);
  };

  const seekToFrame = (frame) => {
    if (videoRef.current) {
      videoRef.current.currentTime = frame / fps;
      videoRef.current.play().catch(() => {});
    }
  };

  const handleEventClick = (event) => {
    onSeekEvent(event.id);
    seekToFrame(event.start_frame);
  };

  const handleVerdictClick = (e, eventId, verdict) => {
    e.preventDefault();
    e.stopPropagation();
    onVerdict(eventId, verdict);
  };

  const handleJumpToFrame = (e) => {
    e.preventDefault();
    const frame = parseInt(jumpFrameInput, 10);
    if (Number.isNaN(frame) || frame < 0 || frame > maxFrame) return;
    seekToFrame(frame);
  };

  const getVerdict = (eventId) => reviewsByEventId[eventId]?.verdict ?? 'pending';
  const activeReviewEvent = visibleEvents.find((e) => e.id === activeEventId)
    || visibleEvents.find((e) => e.id === playingEventId)
    || null;

  return (
    <div className="flyt-dash">
      <div className="flyt-dash-main">
        <div className="flyt-title-row">
          <div>
            <div className="flyt-eyeline">
              {runProvenance.filename || 'unknown file'}
              {' · '}
              <span title={runProvenance.runId}>{shortRunId(runProvenance.runId)}</span>
              {isHistoricRun ? ' · historic' : ''}
            </div>
            <h1 className="flyt-h1">Two-fly courtship assay</h1>
            <p className="flyt-lead">
              Completed tracking record with measured trajectories, review candidates, and published outputs.
              {' '}
              {formatRunDate(runTimestamp || runProvenance.timestamp)}.
            </p>
          </div>
          <span className={`flyt-status ${integrityPassed ? '' : 'muted'}`}>
            {integrity ? (integrityPassed ? 'Integrity passed' : 'Integrity incomplete') : 'No integrity metadata'}
          </span>
        </div>

        <dl className="flyt-summary">
          <div>
            <dt>Frames</dt>
            <dd>{formatCount(frameTotal)}</dd>
            <small>{fps} frames per second</small>
          </div>
          <div>
            <dt>Valid tracking</dt>
            <dd>{validity?.available ? `${validity.percent}%` : 'n/a'}</dd>
            <small>
              {validity?.available
                ? `${formatCount(validity.validFrames)} two-fly frames`
                : 'Metadata not available'}
            </small>
          </div>
          <div>
            <dt>Avg proximity</dt>
            <dd>{Number.isFinite(stats.avgProximity) ? stats.avgProximity.toFixed(1) : 'n/a'} px</dd>
            <small>Invalid frames excluded</small>
          </div>
          <div>
            <dt>Detected bouts</dt>
            <dd>{formatCount(stats.courtshipDetected)}</dd>
            <small>{formatCount(stats.courtshipVerified)} verified · sleep proxy {formatCount(stats.sleepTime)}s</small>
          </div>
        </dl>

        <section aria-labelledby="observation-title">
          <div className="flyt-section-head">
            <h2 className="flyt-h2" id="observation-title">Observation</h2>
            <a className="flyt-section-link" href="#record">View run record</a>
          </div>
          <div className="flyt-video-card no-print">
            <div className="flyt-video-frame">
              {isHistoricRun ? (
                <div className="flyt-video-placeholder">
                  <p>Video preview not available for historic runs.</p>
                  <p>CSV and events were archived; the annotated video was not.</p>
                </div>
              ) : videoAvailable && runProvenance?.runId ? (
                <video
                  ref={videoRef}
                  key={`${runProvenance.runId}-${mediaCacheBust}`}
                  controls
                  preload="metadata"
                  onTimeUpdate={handleVideoTimeUpdate}
                  src={`/tracked.mp4?t=${mediaCacheBust}`}
                />
              ) : (
                <div className="flyt-video-placeholder">
                  <p>No validated current-run video.</p>
                  <p>Complete a tracking run to load the annotated feed for that run ID.</p>
                </div>
              )}
            </div>
            <div className="flyt-video-caption">
              <span>Annotated tracking video. Trajectories remain linked to frame measurements.</span>
              <code className="mono">
                Frame {currentFrame} / {maxFrame} · {fps} fps · {formatClock(currentFrame / fps)}
              </code>
            </div>
            <div className="flyt-frame-controls no-print">
              <label htmlFor="jump-frame-input">Frame</label>
              <input
                id="jump-frame-input"
                className="flyt-input mono"
                type="number"
                min={0}
                max={maxFrame}
                value={jumpFrameInput}
                onChange={(e) => setJumpFrameInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') handleJumpToFrame(e); }}
                placeholder={`0-${maxFrame}`}
              />
              <button type="button" className="flyt-btn flyt-btn-dark" onClick={handleJumpToFrame}>
                Jump to frame
              </button>
            </div>
          </div>
        </section>

        <div className="flyt-charts">
          <section className="flyt-card flyt-chart" aria-labelledby="velocity-title">
            <h3 className="flyt-h3" id="velocity-title">Velocity over time</h3>
            <p>Pixels per second for both tracked subjects</p>
            <div className="flyt-chart-body">
              <ResponsiveContainer width="100%" height={180}>
                <LineChart data={data} margin={{ top: 5, right: 8, left: -12, bottom: 0 }}>
                  <CartesianGrid stroke={CHART_COLORS.grid} strokeDasharray="0" vertical={false} />
                  <XAxis dataKey="frame" tick={{ fill: CHART_COLORS.tick, fontSize: 10 }} tickLine={false} axisLine={false} />
                  <YAxis tick={{ fill: CHART_COLORS.tick, fontSize: 10 }} tickLine={false} axisLine={false} />
                  <Tooltip content={<CustomTooltip />} />
                  <Line type="monotone" dot={false} dataKey="fly1_speed_pxsec" name="Fly 1" stroke={CHART_COLORS.fly1} strokeWidth={1.8} />
                  <Line type="monotone" dot={false} dataKey="fly2_speed_pxsec" name="Fly 2" stroke={CHART_COLORS.fly2} strokeWidth={1.6} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </section>

          <section className="flyt-validity" aria-labelledby="validity-title">
            <div>
              <h3 id="validity-title">Measured tracking validity</h3>
              <p>
                Share of frames with two separate fly observations. This is a measurement condition, not an accuracy score.
              </p>
            </div>
            <div className="flyt-validity-number">
              {validity?.available ? `${validity.percent}%` : 'n/a'}
              <small>
                {validity?.available
                  ? `${formatCount(validity.validFrames)} of ${formatCount(validity.totalFrames)} frames`
                  : 'Not available for this dataset'}
              </small>
            </div>
          </section>

          <section className="flyt-card flyt-chart" aria-labelledby="prox-title">
            <h3 className="flyt-h3" id="prox-title">Inter-fly proximity</h3>
            <p>Centroid distance (px). Core CSV values shown; averages exclude invalid frames.</p>
            <div className="flyt-chart-body">
              <ResponsiveContainer width="100%" height={180}>
                <AreaChart data={data} margin={{ top: 5, right: 8, left: -12, bottom: 0 }}>
                  <CartesianGrid stroke={CHART_COLORS.grid} vertical={false} />
                  <XAxis dataKey="frame" tick={{ fill: CHART_COLORS.tick, fontSize: 10 }} tickLine={false} axisLine={false} />
                  <YAxis tick={{ fill: CHART_COLORS.tick, fontSize: 10 }} tickLine={false} axisLine={false} />
                  <Tooltip content={<CustomTooltip />} />
                  <Area type="step" dot={false} dataKey="proximity_distance" name="Proximity" stroke={CHART_COLORS.prox} strokeWidth={1.5} fill={CHART_COLORS.prox} fillOpacity={0.08} />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </section>

          <section className="flyt-card flyt-chart" aria-labelledby="heat-title">
            <h3 className="flyt-h3" id="heat-title">Spatial density</h3>
            <p>Fly 1 XY sample (1 in 5 frames)</p>
            <div className="flyt-chart-body">
              <ResponsiveContainer width="100%" height={180}>
                <ScatterChart margin={{ top: 8, right: 8, left: -20, bottom: 0 }}>
                  <XAxis type="number" dataKey="x" name="X" tick={{ fill: CHART_COLORS.tick, fontSize: 10 }} domain={['dataMin', 'dataMax']} />
                  <YAxis type="number" dataKey="y" name="Y" tick={{ fill: CHART_COLORS.tick, fontSize: 10 }} domain={['dataMin', 'dataMax']} reversed />
                  <ZAxis type="number" range={[12, 18]} />
                  <Scatter data={heatmapData} fill={CHART_COLORS.fly1} fillOpacity={0.18} />
                </ScatterChart>
              </ResponsiveContainer>
            </div>
          </section>
        </div>

        <RunLogPanel runProvenance={runProvenance} trackingValidity={trackingValidity} />
      </div>

      <aside className="flyt-aside no-print" aria-labelledby="review-title">
        <div className="flyt-aside-inner">
          <div className="flyt-aside-title">
            <h2 className="flyt-h2-serif" id="review-title">Review notes</h2>
            <span className="flyt-count" aria-label={`${pendingCount} pending`}>{pendingCount}</span>
          </div>
          <p className="flyt-aside-copy">
            Detected candidates are listed for manual review. Researcher verdicts are stored separately from tracker output.
          </p>
          <label className="flyt-filter">
            <input
              type="checkbox"
              checked={showLowConfidence}
              onChange={(e) => setShowLowConfidence(e.target.checked)}
            />
            Show low-confidence segments
          </label>

          {visibleEvents.length === 0 ? (
            <p className="flyt-muted">No review candidates for this run.</p>
          ) : (
            <div className="flyt-event-list" role="list">
              {visibleEvents.map((event) => {
                const verdict = getVerdict(event.id);
                const isActive = playingEventId === event.id || activeEventId === event.id;
                return (
                  <button
                    key={event.id}
                    type="button"
                    role="listitem"
                    className={`flyt-event ${isActive ? 'active' : ''}`}
                    onClick={() => handleEventClick(event)}
                  >
                    <span className="flyt-event-top">
                      <span className="flyt-event-name">{eventTypeLabel(event.type)}</span>
                      <time>{formatClock(event.start_time_sec)}</time>
                    </span>
                    <small>
                      Frames {event.start_frame}-{event.end_frame}
                      {' · '}
                      {Number(event.duration_sec).toFixed(1)}s
                      {event.mean_proximity_px != null ? ` · mean prox ${event.mean_proximity_px}px` : ''}
                    </small>
                    <span className="flyt-event-tags">
                      <span className="flyt-badge detected">detected</span>
                      <span className={`flyt-badge ${verdict}`}>{verdict}</span>
                    </span>
                  </button>
                );
              })}
            </div>
          )}

          <div className="flyt-review-buttons">
            <button
              type="button"
              className={`flyt-btn flyt-btn-reject ${activeReviewEvent && getVerdict(activeReviewEvent.id) === 'rejected' ? 'is-active' : ''}`}
              disabled={!activeReviewEvent}
              aria-pressed={activeReviewEvent ? getVerdict(activeReviewEvent.id) === 'rejected' : false}
              onClick={(e) => activeReviewEvent && handleVerdictClick(e, activeReviewEvent.id, 'rejected')}
            >
              <X size={14} /> Reject
            </button>
            <button
              type="button"
              className={`flyt-btn flyt-btn-confirm ${activeReviewEvent && getVerdict(activeReviewEvent.id) === 'confirmed' ? 'is-active' : ''}`}
              disabled={!activeReviewEvent}
              aria-pressed={activeReviewEvent ? getVerdict(activeReviewEvent.id) === 'confirmed' : false}
              onClick={(e) => activeReviewEvent && handleVerdictClick(e, activeReviewEvent.id, 'confirmed')}
            >
              <Check size={14} /> Confirm
            </button>
          </div>
          {activeReviewEvent && (
            <p className="flyt-muted flyt-mono" style={{ margin: 0, fontSize: 10 }}>
              Selected: {activeReviewEvent.id}
            </p>
          )}

          <section className="flyt-card flyt-reference">
            <img src="/validation-loop.svg" alt="Detection and verification remain separate steps" />
            <div>
              <h3>Detection stays separate from evidence</h3>
              <p>Researcher decisions are stored without rewriting the raw tracker output.</p>
            </div>
          </section>
        </div>
      </aside>
    </div>
  );
}

function UploadView({ uploadJob, onFileSelect, onCancel }) {
  const fileInputRef = useRef(null);
  const isProcessing = uploadJob.active;
  const isCancelling = Boolean(uploadJob.cancelling);
  const total = uploadJob.totalFrames;
  const frames = uploadJob.framesProcessed || 0;
  const hasTotal = Number.isFinite(total) && total > 0;
  const pct = hasTotal ? Math.min(100, Math.round((frames / total) * 100)) : null;
  const stages = Array.isArray(uploadJob.stageLog) ? uploadJob.stageLog : [];
  const elapsedMs = Number.isFinite(uploadJob.elapsedMs) ? uploadJob.elapsedMs : null;
  const fpsRate = elapsedMs > 1000 && frames > 0
    ? Math.round((frames / (elapsedMs / 1000)) * 10) / 10
    : null;
  const etaMs = hasTotal && fpsRate > 0 && frames < total
    ? Math.round(((total - frames) / fpsRate) * 1000)
    : null;
  const isTracking = hasTotal && frames > 0 && frames < total && !isCancelling;
  const ringStyle = pct !== null
    ? { '--flyt-ring-pct': String(pct) }
    : undefined;

  const handleFileChange = (e) => {
    if (!e.target.files || e.target.files.length === 0) return;
    onFileSelect(e.target.files[0]);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  return (
    <div className="flyt-page compact" style={{ paddingTop: 8 }}>
      <div className="flyt-title-row">
        <div>
          <div className="flyt-eyeline">local analysis</div>
          <h1 className="flyt-h1">New run</h1>
          <p className="flyt-lead">
            Upload a courtship video. Tracker settings from the Settings panel apply to the next upload.
          </p>
        </div>
      </div>

      {isProcessing ? (
        <div className="flyt-panel flyt-loader-card" style={{ maxWidth: 520, margin: '0 auto' }}>
          <div className="flyt-loader-visual" aria-hidden="true">
            {hasTotal && !isCancelling ? (
              <div className={`flyt-ring ${isTracking ? 'is-live' : ''}`} style={ringStyle}>
                <div className="flyt-ring-inner">
                  <span className="flyt-ring-value flyt-mono">{pct ?? 0}</span>
                  <span className="flyt-ring-unit">%</span>
                </div>
              </div>
            ) : (
              <div className="flyt-orbit" role="presentation">
                <span className="flyt-orbit-core" />
                <span className="flyt-orbit-dot" />
              </div>
            )}
          </div>

          <p className="flyt-loader-title">
            {uploadJob.progress || 'Initializing...'}
          </p>
          {uploadJob.runId && (
            <p className="flyt-muted flyt-mono flyt-loader-meta" title={uploadJob.runId}>
              {shortRunId(uploadJob.runId)}
              {uploadJob.uploadedFilename ? ` · ${uploadJob.uploadedFilename}` : ''}
            </p>
          )}

          {hasTotal && !isCancelling ? (
            <div className="flyt-loader-meter-block">
              <div className="flyt-loader-stats">
                <span className="flyt-mono" style={{ fontWeight: 650 }}>
                  {frames.toLocaleString()} / {total.toLocaleString()} frames
                </span>
                <span className="flyt-mono flyt-muted">{pct}%</span>
              </div>
              <div
                className={`flyt-meter flyt-meter-lg ${frames === 0 ? 'is-indeterminate' : ''}`}
                role="progressbar"
                aria-valuenow={pct}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-label="Tracking progress"
              >
                <span style={{ width: frames === 0 ? '28%' : `${pct}%` }} />
              </div>
            </div>
          ) : (
            <div className="flyt-loader-meter-block">
              <div className="flyt-meter flyt-meter-lg is-indeterminate" role="progressbar" aria-label={isCancelling ? 'Cancelling run' : 'Preparing tracker'}>
                <span />
              </div>
              <p className="flyt-muted" style={{ margin: '10px 0 0', fontSize: 12, textAlign: 'center' }}>
                {isCancelling
                  ? 'Stopping tracker processes and clearing the run workspace…'
                  : 'Counting frames and starting the tracker…'}
              </p>
            </div>
          )}

          {!isCancelling && (
            <div className="flyt-loader-kpis">
              {elapsedMs !== null && (
                <div>
                  <span className="flyt-kpi-label">Elapsed</span>
                  <span className="flyt-mono">{formatDurationMs(elapsedMs)}</span>
                </div>
              )}
              {fpsRate !== null && (
                <div>
                  <span className="flyt-kpi-label">Rate</span>
                  <span className="flyt-mono">{fpsRate} fps</span>
                </div>
              )}
              {etaMs !== null && (
                <div>
                  <span className="flyt-kpi-label">ETA</span>
                  <span className="flyt-mono">~{formatDurationMs(etaMs)}</span>
                </div>
              )}
              {!hasTotal && frames === 0 && (
                <div>
                  <span className="flyt-kpi-label">Status</span>
                  <span>Preparing</span>
                </div>
              )}
            </div>
          )}

          <div className="flyt-loader-actions">
            <button
              type="button"
              className="flyt-btn flyt-btn-cancel"
              onClick={onCancel}
              disabled={isCancelling || !onCancel}
              aria-busy={isCancelling}
            >
              <X size={14} />
              {isCancelling ? 'Cancelling…' : 'Cancel run'}
            </button>
          </div>

          {stages.length > 0 && (
            <ul className="flyt-stage-list" style={{ listStyle: 'none', padding: 0, textAlign: 'left', marginTop: 16 }}>
              {stages.slice(-8).map((entry, index) => (
                <li key={`${entry.t}-${entry.stage}-${index}`}>
                  <time>{formatStageTime(entry.t)}</time>
                  <span>{entry.message || entry.stage}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : (
        <div style={{ maxWidth: 520, margin: '0 auto' }}>
          {uploadJob.notice && (
            <div className="flyt-notice" role="status">
              <p style={{ fontWeight: 650, margin: 0 }}>{uploadJob.notice}</p>
            </div>
          )}
          {uploadJob.error && (
            <div className="flyt-error" role="alert">
              <p style={{ fontWeight: 650 }}>{uploadJob.error}</p>
              {uploadJob.resultPublished === false && (
                <p>
                  No new result was published. Previous published output (if any) was left intact. Open History to review a prior run.
                </p>
              )}
              {Array.isArray(uploadJob.stageLog) && uploadJob.stageLog.length > 0 && (
                <ul className="flyt-stage-list" style={{ listStyle: 'none', padding: 0, marginTop: 10, background: 'transparent' }}>
                  {uploadJob.stageLog.slice(-10).map((entry, index) => (
                    <li key={`err-${entry.t}-${index}`} className="flyt-mono">
                      <time>{formatStageTime(entry.t)}</time>
                      <span>{entry.message || entry.stage}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          <div
            role="button"
            tabIndex={0}
            className="flyt-dropzone"
            onClick={() => fileInputRef.current?.click()}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                fileInputRef.current?.click();
              }
            }}
          >
            <UploadCloud size={28} style={{ color: 'var(--faint)' }} />
            <h3>Select video file</h3>
            <p>MP4, AVI, or MOV · up to 10 GB</p>
            <input
              type="file"
              ref={fileInputRef}
              onChange={handleFileChange}
              className="sr-only"
              style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)' }}
              accept=".mp4,.avi,.mov"
            />
          </div>
        </div>
      )}
    </div>
  );
}

// Mounted only while open (see App). Fresh mount resets draft from last applied
// settings. Cancel unmounts without onApply.
function SettingsModal({ onClose, settings, onApply }) {
  const [draft, setDraft] = React.useState(() => ({ ...settings }));
  const [showAdvanced, setShowAdvanced] = React.useState(false);

  const setField = (key) => (e) => {
    const val = e.target.type === 'number' ? Number(e.target.value) : e.target.value;
    setDraft((d) => ({ ...d, [key]: val }));
  };

  const apply = () => {
    onApply(draft);
    onClose();
  };

  const resetDefaults = () => setDraft({ minArea: 30, maxArea: 0, proximityThreshold: 60, boutMinFrames: 90 });

  return (
    <div className="flyt-modal-backdrop no-print" onClick={onClose} role="presentation">
      <div
        className="flyt-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          className="flyt-btn flyt-btn-ghost"
          onClick={onClose}
          aria-label="Close settings"
          style={{ position: 'absolute', top: 12, right: 12 }}
        >
          <X size={16} />
        </button>
        <h2 id="settings-title">Tracker settings</h2>
        <p className="flyt-muted" style={{ margin: '0 0 20px' }}>
          Applied on the next upload. Defaults match the pitch baseline.
        </p>

        <div className="flyt-field">
          <label htmlFor="set-min-area">Min contour area (px²)</label>
          <p>Ignore foreground blobs smaller than this (noise / debris).</p>
          <input id="set-min-area" className="flyt-input" type="number" min={0} value={draft.minArea} onChange={setField('minArea')} />
        </div>

        <div className="flyt-field">
          <label htmlFor="set-prox">Proximity threshold (px)</label>
          <p>Centroid distance that defines a courtship bout.</p>
          <input id="set-prox" className="flyt-input" type="number" min={0} value={draft.proximityThreshold} onChange={setField('proximityThreshold')} />
        </div>

        <div className="flyt-field">
          <label htmlFor="set-bout">Bout min frames</label>
          <p>Consecutive proximity frames required for a bout (~3s at 30fps = 90).</p>
          <input id="set-bout" className="flyt-input" type="number" min={1} value={draft.boutMinFrames} onChange={setField('boutMinFrames')} />
        </div>

        <button
          type="button"
          className="flyt-btn flyt-btn-ghost"
          onClick={() => setShowAdvanced((s) => !s)}
          style={{ marginBottom: 12, paddingLeft: 0 }}
        >
          <ChevronDown size={12} style={{ transform: showAdvanced ? 'rotate(180deg)' : 'none' }} />
          Advanced
        </button>

        {showAdvanced && (
          <div className="flyt-field">
            <label htmlFor="set-max-area">Max contour area (px²)</label>
            <p>Upper area bound (0 = no limit). Pitch uses 0; raise to ignore the cotton plug.</p>
            <input id="set-max-area" className="flyt-input" type="number" min={0} value={draft.maxArea} onChange={setField('maxArea')} />
          </div>
        )}

        <div className="flyt-modal-actions">
          <button type="button" className="flyt-btn" onClick={resetDefaults}>Reset</button>
          <button type="button" className="flyt-btn flyt-btn-dark" onClick={apply}>Apply configuration</button>
        </div>
      </div>
    </div>
  );
}

function App() {
  const [data, setData] = useState([]);
  const [heatmapData, setHeatmapData] = useState([]);
  const [stats, setStats] = useState({
    avgProximity: 0,
    maxActivity: 0,
    sleepTime: 0,
    courtshipDetected: 0,
    courtshipVerified: 0,
  });
  const [events, setEvents] = useState([]);
  const [reviewsByEventId, setReviewsByEventId] = useState({});
  const [runTimestamp, setRunTimestamp] = useState(null);
  const [mediaCacheBust, setMediaCacheBust] = useState(Date.now());
  const [runFps, setRunFps] = useState(30);
  const [totalFrames, setTotalFrames] = useState(0);
  const [isHistoricRun, setIsHistoricRun] = useState(false);
  const [runProvenance, setRunProvenance] = useState(null);
  const [videoAvailable, setVideoAvailable] = useState(false);
  const [trackingValidity, setTrackingValidity] = useState(null);
  const [activeEventId, setActiveEventId] = useState(null);
  const [activeTab, setActiveTab] = useState('dashboard');
  const [isDark, setIsDark] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  // Tracker settings - defaults match the pitch baseline. Sent to /api/upload
  // as multipart fields, validated server-side in buildTrackerArgs.
  const [settings, setSettings] = useState({
    minArea: 30,
    maxArea: 0,
    proximityThreshold: 60,
    boutMinFrames: 90,
  });
  const [history, setHistory] = useState([]);
  const [uploadJob, setUploadJob] = useState({
    active: false,
    cancelling: false,
    progress: '',
    framesProcessed: 0,
    totalFrames: null,
    error: null,
    notice: null,
    runId: null,
    uploadedFilename: null,
    stageLog: [],
    elapsedMs: null,
    resultPublished: null,
  });
  const pollRef = useRef(null);
  const loadGenerationRef = useRef(0);
  const uploadAbortRef = useRef(null);
  const cancellingRef = useRef(false);
  // Latest fps for loadAll fallback without re-creating the callback each frame update.
  const runFpsRef = useRef(runFps);
  runFpsRef.current = runFps;

  const clearCurrentResultDisplay = useCallback(() => {
    setData([]);
    setHeatmapData([]);
    setEvents([]);
    setReviewsByEventId({});
    setRunTimestamp(null);
    setRunProvenance(null);
    setVideoAvailable(false);
    setTrackingValidity(null);
    setTotalFrames(0);
    setIsHistoricRun(false);
    setActiveEventId(null);
    setStats({
      avgProximity: 0,
      maxActivity: 0,
      sleepTime: 0,
      courtshipDetected: 0,
      courtshipVerified: 0,
    });
  }, []);

  const loadEventsAndVerification = useCallback(async (cacheBust = Date.now(), generation = loadGenerationRef.current, runId = null) => {
    let eventList = [];
    const reviews = {};
    let fps = 30;
    let frames = 0;
    let metadata = null;

    if (!runId) {
      try {
        const metaRes = await fetch(`/run_metadata.json?t=${cacheBust}`, { cache: 'no-store' });
        if (metaRes.ok) {
          metadata = await metaRes.json();
          if (metadata.fps) fps = metadata.fps;
        }
      } catch { /* metadata optional */ }
    } else {
      try {
        const metaRes = await fetch(`/history/${runId}/run_metadata.json?t=${cacheBust}`, { cache: 'no-store' });
        if (metaRes.ok) metadata = await metaRes.json();
      } catch { /* historic metadata optional */ }
    }

    try {
      const eventsUrl = runId ? `/history/${runId}/events.json` : '/api/events';
      const eventsRes = await fetch(`${eventsUrl}?t=${cacheBust}`, { cache: 'no-store' });
      if (eventsRes.ok) {
        const eventsData = await eventsRes.json();
        if (eventsData.fps) fps = eventsData.fps;
        if (eventsData.total_frames) frames = eventsData.total_frames;
        eventList = (eventsData.events || []).slice().sort(
          (a, b) => a.start_time_sec - b.start_time_sec
        );
      }
    } catch { /* events optional until first track */ }

    try {
      const verificationUrl = runId
        ? `/api/verification?runId=${encodeURIComponent(runId)}&t=${cacheBust}`
        : `/api/verification?t=${cacheBust}`;
      const verRes = await fetch(verificationUrl, { cache: 'no-store' });
      if (verRes.ok) {
        const verData = await verRes.json();
        (verData.reviews || []).forEach((r) => {
          reviews[r.event_id] = r;
        });
      }
    } catch { /* keep empty reviews */ }

    if (generation !== loadGenerationRef.current) return { fps: 30, metadata: null };

    if (frames > 0) setTotalFrames(frames);
    setRunFps(fps);
    setEvents(eventList);
    setReviewsByEventId(reviews);
    setStats((prev) => {
      const { detected, verified } = computeCourtshipStats(eventList, reviews);
      return { ...prev, courtshipDetected: detected, courtshipVerified: verified };
    });
    return { fps, frames, metadata };
  }, []);

  const loadData = useCallback((cacheBust = Date.now(), generation = loadGenerationRef.current, customPath = null, fps = 30) => new Promise((resolve) => {
    const url = customPath ? `${customPath}${customPath.includes('?') ? '&' : '?'}t=${cacheBust}` : `/data.csv?t=${cacheBust}`;
    Papa.parse(url, {
      download: true,
      header: true,
      dynamicTyping: true,
      complete: (results) => {
        if (generation !== loadGenerationRef.current) {
          resolve(0);
          return;
        }
        const parsedData = results.data.filter(
          (row) => row.frame !== null && row.frame !== undefined && row.frame !== ''
        );

        const effectiveFps = (fps && fps > 0) ? fps : 30;

        // Ensure px/sec speed columns exist for legacy CSVs (pre-K-08 or old history snapshots).
        // Use the run's effective fps (or 30 fallback) for approximation.
        parsedData.forEach((row) => {
          if (row.fly1_speed_pxsec == null && typeof row.fly1_speed === 'number') {
            row.fly1_speed_pxsec = row.fly1_speed * effectiveFps;
          }
          if (row.fly2_speed_pxsec == null && typeof row.fly2_speed === 'number') {
            row.fly2_speed_pxsec = row.fly2_speed * effectiveFps;
          }
        });

        const immobilityThresholdSec = 5;
        const sleepThresholdFrames = Math.round(immobilityThresholdSec * effectiveFps);

        // Low activity threshold for sleep proxy. activity_level comes from countNonZero on foreground mask.
        // This is an ad-hoc heuristic (not a standard Drosophila sleep definition).
        const LOW_ACTIVITY_THRESHOLD = 10;

        let totalProx = 0;
        let proxCount = 0;
        let maxAct = 0;

        let framesZeroActivity = 0;
        let totalSleepSec = 0;

        const hmData = [];

        parsedData.forEach((row, i) => {
          // Only measured two-fly observations contribute. Dropouts retain
          // display coordinates but carry no scientifically valid proximity.
          const observedProximity = proximityValue(row);
          if (observedProximity !== null) {
            totalProx += observedProximity;
            proxCount++;
          }
          if (row.activity_level > maxAct) maxAct = row.activity_level;

          if (row.activity_level < LOW_ACTIVITY_THRESHOLD) {
            framesZeroActivity++;
          } else {
            if (framesZeroActivity > sleepThresholdFrames) {
              totalSleepSec += Math.floor(framesZeroActivity / effectiveFps);
            }
            framesZeroActivity = 0;
          }

          if (i % 5 === 0 && row.fly1_x && row.fly1_y) {
            hmData.push({ x: row.fly1_x, y: row.fly1_y });
          }
        });

        if (framesZeroActivity > sleepThresholdFrames) totalSleepSec += Math.floor(framesZeroActivity / effectiveFps);

        setStats((prev) => ({
          ...prev,
          avgProximity: proxCount > 0 ? Math.round(totalProx / proxCount) : 0,
          maxActivity: maxAct,
          sleepTime: totalSleepSec,
        }));
        setData(parsedData);
        setHeatmapData(hmData);
        setTotalFrames((prev) => (prev > 0 ? prev : parsedData.length));
        resolve({ rowCount: parsedData.length, trackingValidity: summarizeTrackingValidity(parsedData) });
      },
      error: () => resolve({ rowCount: 0, trackingValidity: null }),
    });
  }), []);

  const handleVerdict = async (eventId, verdict) => {
    try {
      const res = await fetch('/api/verification', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ eventId, verdict }),
      });
      if (!res.ok) return;
      const { review } = await res.json();
      setReviewsByEventId((prev) => {
        const next = { ...prev, [review.event_id]: review };
        const { detected, verified } = computeCourtshipStats(events, next);
        setStats((s) => ({ ...s, courtshipDetected: detected, courtshipVerified: verified }));
        return next;
      });
    } catch (err) {
      console.error('Verification failed:', err);
    }
  };

  const loadHistory = useCallback(async (cacheBust = Date.now()) => {
    try {
      const res = await fetch(`/api/history?t=${cacheBust}`, { cache: 'no-store' });
      if (!res.ok) return;
      const hist = await res.json();
      setHistory(Array.isArray(hist.runs) ? hist.runs : []);
    } catch { /* history optional */ }
  }, []);

  // Load a past run's snapshot (data.csv + events.json from public/history/<runId>/)
  // into the active dashboard. Video for past runs is not snapshotted - clear it
  // so the player doesn't show a stale frame.
  const loadHistoricRun = async (run) => {
    const runId = run.runId;
    const generation = ++loadGenerationRef.current;
    const cacheBust = Date.now();
    setMediaCacheBust(cacheBust);
    setVideoAvailable(false);
    setIsHistoricRun(true);
    setRunTimestamp(run.timestamp || null);
    setTrackingValidity(run.trackingValidity || null);
    setRunProvenance({
      runId,
      filename: run.filename || null,
      timestamp: run.timestamp || null,
      durationMs: Number.isFinite(run.durationSec) ? run.durationSec * 1000 : null,
      stageLog: run.stageLog || null,
      frameIntegrity: run.frameIntegrity || null,
      trackingValidity: run.trackingValidity || null,
      startTime: run.startTime || null,
      endTime: run.endTime || run.timestamp || null,
    });
    try {
      // Load events first to get accurate fps (avoids stale state) for sleep + pxsec normalization
      const eventResult = await loadEventsAndVerification(cacheBust, generation, runId);
      if (generation !== loadGenerationRef.current) return;
      const historicFps = (eventResult && eventResult.fps > 0) ? eventResult.fps : 30;
      const meta = eventResult?.metadata;
      if (meta && meta.runId === runId) {
        setRunProvenance({
          runId: meta.runId,
          filename: meta.filename || run.filename || null,
          timestamp: meta.timestamp || run.timestamp || null,
          durationMs: meta.durationMs ?? (Number.isFinite(run.durationSec) ? run.durationSec * 1000 : null),
          stageLog: meta.stageLog || run.stageLog || null,
          frameIntegrity: meta.frameIntegrity || run.frameIntegrity || null,
          trackingValidity: meta.trackingValidity || run.trackingValidity || null,
          startTime: meta.startTime || run.startTime || null,
          endTime: meta.endTime || meta.timestamp || run.timestamp || null,
        });
        if (meta.trackingValidity) setTrackingValidity(meta.trackingValidity);
        if (meta.timestamp) setRunTimestamp(meta.timestamp);
      }
      const dataResult = await loadData(cacheBust, generation, `/history/${runId}/data.csv`, historicFps);
      if (generation !== loadGenerationRef.current) return;
      if (!run.trackingValidity && !meta?.trackingValidity && dataResult?.trackingValidity) {
        setTrackingValidity(dataResult.trackingValidity);
      }
    } catch (e) {
      console.error('Failed to load historic run:', e);
    }
    setActiveTab('dashboard');
  };

  const clearHistoryServer = async () => {
    try {
      const res = await fetch('/api/history', { method: 'DELETE' });
      if (res.ok) {
        setHistory([]);
      }
    } catch (e) {
      console.error('Failed to clear history:', e);
    }
  };

  /**
   * Load the current published bundle only when metadata.runId matches expectedRunId
   * (when provided). Prevents stale async loads from attaching the wrong run's video.
   */
  const loadAll = useCallback(async (cacheBust = Date.now(), expectedRunId = null) => {
    const generation = ++loadGenerationRef.current;
    setMediaCacheBust(cacheBust);
    setIsHistoricRun(false);
    setVideoAvailable(false);
    // Load events first to get accurate fps for loadData (sleep calc + any legacy pxsec normalization)
    const eventsResult = await loadEventsAndVerification(cacheBust, generation);
    if (generation !== loadGenerationRef.current) return false;
    const meta = eventsResult?.metadata || null;
    if (expectedRunId) {
      if (!meta?.runId || meta.runId !== expectedRunId) {
        return false;
      }
    }
    if (!meta?.runId) {
      // No validated published run - do not present a bare tracked.mp4.
      setRunProvenance(null);
      setRunTimestamp(null);
      setTrackingValidity(null);
      await loadHistory(cacheBust);
      return false;
    }

    const currentFps = (eventsResult && eventsResult.fps > 0) ? eventsResult.fps : runFpsRef.current;
    const [dataResult] = await Promise.all([
      loadData(cacheBust, generation, null, currentFps),
      loadHistory(cacheBust),
    ]);
    if (generation !== loadGenerationRef.current) return false;

    const validity = meta.trackingValidity?.available
      ? meta.trackingValidity
      : (dataResult?.trackingValidity || null);
    setTrackingValidity(validity);
    setRunTimestamp(meta.timestamp || null);
    setRunProvenance({
      runId: meta.runId,
      filename: meta.filename || null,
      timestamp: meta.timestamp || null,
      durationMs: meta.durationMs ?? null,
      stageLog: meta.stageLog || null,
      frameIntegrity: meta.frameIntegrity || {
        passed: meta.syncOk === true,
        inputFrames: meta.inputFrames,
        trackerFrames: meta.trackerFrames,
        csvRows: meta.csvRows,
        rawVideoFrames: meta.rawVideoFrames,
        finalVideoFrames: meta.finalVideoFrames,
        syncOk: meta.syncOk,
      },
      trackingValidity: validity,
      startTime: meta.startTime || null,
      endTime: meta.endTime || meta.timestamp || null,
    });
    // Only show annotated video when provenance is matched to published metadata.
    setVideoAvailable(true);
    return true;
  }, [loadEventsAndVerification, loadData, loadHistory]);

  useEffect(() => {
    loadHistory();
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [loadHistory]);

  useEffect(() => {
    // Poll only after the server accepted the upload (runId present). Pre-runId
    // the server is still idle and must not be treated as a cancelled run.
    // While cancelling, handleCancelRun owns UI and awaits POST /api/reset.
    if (!uploadJob.active || uploadJob.cancelling || !uploadJob.runId) return undefined;

    const poll = async () => {
      try {
        if (cancellingRef.current) return;
        const statusRes = await fetch(`/api/status?t=${Date.now()}`, { cache: 'no-store' });
        const status = await statusRes.json();
        if (cancellingRef.current) return;

        setUploadJob((prev) => {
          if (prev.cancelling) return prev;
          if (status.status === 'stopping') {
            return {
              ...prev,
              progress: 'Stopping run...',
              stageLog: Array.isArray(status.stageLog) ? status.stageLog : prev.stageLog,
              elapsedMs: status.elapsedMs ?? status.durationMs ?? prev.elapsedMs,
            };
          }
          return {
            ...prev,
            progress: status.progress || prev.progress,
            framesProcessed: status.framesProcessed || 0,
            totalFrames: status.totalFrames ?? prev.totalFrames,
            runId: status.runId || prev.runId,
            uploadedFilename: status.uploadedFilename || prev.uploadedFilename,
            stageLog: Array.isArray(status.stageLog) ? status.stageLog : prev.stageLog,
            elapsedMs: status.elapsedMs ?? status.durationMs ?? prev.elapsedMs,
            resultPublished: status.resultPublished ?? prev.resultPublished,
          };
        });

        if (status.status === 'done') {
          if (pollRef.current) clearInterval(pollRef.current);
          pollRef.current = null;
          if (cancellingRef.current) return;
          const completedRunId = status.runId;
          setUploadJob({
            active: false,
            cancelling: false,
            progress: 'Loading results...',
            framesProcessed: status.framesProcessed || 0,
            totalFrames: status.totalFrames,
            error: null,
            notice: null,
            runId: completedRunId,
            uploadedFilename: status.uploadedFilename,
            stageLog: status.stageLog || [],
            elapsedMs: status.durationMs ?? status.elapsedMs,
            resultPublished: true,
          });
          const loaded = await loadAll(Date.now(), completedRunId);
          if (loaded) setActiveTab('dashboard');
          else {
            setUploadJob((prev) => ({
              ...prev,
              error: 'Run finished but published metadata did not match the completed run ID.',
              resultPublished: false,
            }));
          }
        } else if (status.status === 'error') {
          if (pollRef.current) clearInterval(pollRef.current);
          pollRef.current = null;
          if (cancellingRef.current) return;
          // Do not loadAll - keep prior published bundle off the failed-attempt surface.
          const cancelled = /cancel/i.test(status.error || '');
          setUploadJob({
            active: false,
            cancelling: false,
            progress: '',
            framesProcessed: status.framesProcessed || 0,
            totalFrames: status.totalFrames,
            error: cancelled ? null : (status.error || 'Tracking failed. No new result was published.'),
            notice: cancelled
              ? 'Run cancelled. No new result was published; previous output left intact.'
              : null,
            runId: status.runId || null,
            uploadedFilename: status.uploadedFilename || null,
            stageLog: Array.isArray(status.stageLog) ? status.stageLog : [],
            elapsedMs: status.durationMs ?? status.elapsedMs,
            resultPublished: false,
          });
        } else if (status.status === 'idle') {
          // Reset finished after a tracked run (epoch bump); reopen the upload gate in UI.
          if (pollRef.current) clearInterval(pollRef.current);
          pollRef.current = null;
          if (cancellingRef.current) return;
          setUploadJob((prev) => ({
            active: false,
            cancelling: false,
            progress: '',
            framesProcessed: 0,
            totalFrames: null,
            error: null,
            notice: 'Run cancelled. No new result was published; previous output left intact.',
            runId: null,
            uploadedFilename: prev.uploadedFilename,
            stageLog: Array.isArray(status.stageLog) ? status.stageLog : [],
            elapsedMs: status.elapsedMs ?? status.durationMs ?? prev.elapsedMs,
            resultPublished: false,
          }));
        }
      } catch { /* ignore transient poll errors */ }
    };

    pollRef.current = setInterval(poll, 800);
    poll();
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
      pollRef.current = null;
    };
  }, [uploadJob.active, uploadJob.cancelling, uploadJob.runId, loadAll]);

  const handleCancelRun = useCallback(async () => {
    if (cancellingRef.current) return;
    cancellingRef.current = true;
    const generation = loadGenerationRef.current;

    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
    try {
      uploadAbortRef.current?.abort();
    } catch { /* ignore */ }

    setUploadJob((prev) => ({
      ...prev,
      active: true,
      cancelling: true,
      progress: 'Cancelling run...',
      notice: null,
      error: null,
    }));

    try {
      const response = await fetch('/api/reset', { method: 'POST' });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(body.error || 'Could not cancel run');
      }
      if (loadGenerationRef.current !== generation) return;
      setUploadJob({
        active: false,
        cancelling: false,
        progress: '',
        framesProcessed: 0,
        totalFrames: null,
        error: null,
        notice: 'Run cancelled. No new result was published; previous output left intact.',
        runId: null,
        uploadedFilename: null,
        stageLog: [],
        elapsedMs: null,
        resultPublished: false,
      });
    } catch (err) {
      if (loadGenerationRef.current !== generation) return;
      setUploadJob((prev) => ({
        ...prev,
        active: false,
        cancelling: false,
        progress: '',
        error: err.message || 'Could not cancel run',
        notice: null,
        resultPublished: false,
      }));
    } finally {
      cancellingRef.current = false;
    }
  }, []);

  const handleFileSelect = async (file) => {
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = null;
    cancellingRef.current = false;
    try {
      uploadAbortRef.current?.abort();
    } catch { /* ignore */ }
    const controller = new AbortController();
    uploadAbortRef.current = controller;
    loadGenerationRef.current += 1;
    const generation = loadGenerationRef.current;
    setActiveTab('upload');
    // Invalidate any previous result so old tracked.mp4 cannot look like this upload.
    clearCurrentResultDisplay();
    setUploadJob({
      active: true,
      cancelling: false,
      progress: 'Uploading video...',
      framesProcessed: 0,
      totalFrames: null,
      error: null,
      notice: null,
      runId: null,
      uploadedFilename: file?.name || null,
      stageLog: [],
      elapsedMs: 0,
      resultPublished: null,
    });

    const formData = new FormData();
    formData.append('video', file);
    // Settings UI → backend CLI args (Task A / K-04)
    formData.append('minArea', settings.minArea);
    formData.append('maxArea', settings.maxArea);
    formData.append('proximityThreshold', settings.proximityThreshold);
    formData.append('boutMinFrames', settings.boutMinFrames);

    try {
      const response = await fetch('/api/upload', {
        method: 'POST',
        body: formData,
        signal: controller.signal,
      });
      if (loadGenerationRef.current !== generation || cancellingRef.current) return;
      if (!response.ok) {
        const errData = await response.json().catch(() => ({}));
        throw new Error(errData.error || 'Upload failed');
      }
      const body = await response.json().catch(() => ({}));
      if (loadGenerationRef.current !== generation || cancellingRef.current) return;
      setUploadJob({
        active: true,
        cancelling: false,
        progress: 'Starting tracker...',
        framesProcessed: 0,
        totalFrames: null,
        error: null,
        notice: null,
        runId: body.runId || null,
        uploadedFilename: file?.name || null,
        stageLog: [],
        elapsedMs: 0,
        resultPublished: false,
      });
    } catch (err) {
      if (loadGenerationRef.current !== generation) return;
      // User cancelled via AbortController — handleCancelRun owns final UI state.
      if (err?.name === 'AbortError' || cancellingRef.current) return;
      setUploadJob({
        active: false,
        cancelling: false,
        progress: '',
        framesProcessed: 0,
        totalFrames: null,
        error: err.message || 'Upload failed',
        notice: null,
        runId: null,
        uploadedFilename: file?.name || null,
        stageLog: [],
        elapsedMs: null,
        resultPublished: false,
      });
    }
  };

  return (
    <div className={`flyt-app ${isDark ? 'dark' : ''}`}>
      {isSettingsOpen && (
        <SettingsModal
          onClose={() => setIsSettingsOpen(false)}
          settings={settings}
          onApply={setSettings}
        />
      )}

      <header className="flyt-top no-print">
        <button type="button" className="flyt-brand" onClick={() => setActiveTab('dashboard')}>
          <img src="/flyt-mark.svg" alt="" width={25} height={25} />
          <span>Flyt</span>
        </button>
        <nav className="flyt-tabs" aria-label="Primary">
          <button
            type="button"
            className={`flyt-tab ${activeTab === 'dashboard' ? 'active' : ''}`}
            aria-current={activeTab === 'dashboard' ? 'page' : undefined}
            onClick={() => setActiveTab('dashboard')}
          >
            Overview
          </button>
          <button
            type="button"
            className={`flyt-tab ${activeTab === 'upload' ? 'active' : ''}`}
            aria-current={activeTab === 'upload' ? 'page' : undefined}
            onClick={() => setActiveTab('upload')}
          >
            New run
          </button>
          <button
            type="button"
            className={`flyt-tab ${activeTab === 'runs' ? 'active' : ''}`}
            aria-current={activeTab === 'runs' ? 'page' : undefined}
            onClick={() => setActiveTab('runs')}
          >
            History
          </button>
          <button
            type="button"
            className="flyt-tab"
            onClick={() => setIsSettingsOpen(true)}
          >
            Settings
          </button>
        </nav>
        <div className="flyt-top-actions">
          <button
            type="button"
            className="flyt-btn hide-sm"
            disabled={data.length === 0}
            onClick={() => exportPrismCsv(data, runFps)}
          >
            <DownloadCloud size={14} /> CSV
          </button>
          <button type="button" className="flyt-btn flyt-btn-dark hide-sm" onClick={triggerPdfReport}>
            <FileText size={14} /> Print report
          </button>
          <button
            type="button"
            className="flyt-btn flyt-btn-ghost"
            onClick={() => setIsDark(!isDark)}
            aria-label={isDark ? 'Switch to light theme' : 'Switch to dark theme'}
          >
            {isDark ? <Sun size={16} /> : <Moon size={16} />}
          </button>
          <button
            type="button"
            className="flyt-btn flyt-btn-ghost"
            onClick={() => setIsSettingsOpen(true)}
            aria-label="Open settings"
          >
            <Settings size={16} />
          </button>
        </div>
      </header>

      {uploadJob.active && (
        <div className="flyt-progress-bar no-print" role="status">
          <span>{uploadJob.progress}</span>
          {!uploadJob.cancelling && Number.isFinite(uploadJob.totalFrames) && uploadJob.totalFrames > 0 ? (
            <span className="mono">
              {uploadJob.framesProcessed || 0} / {uploadJob.totalFrames}
              {' '}
              ({Math.min(100, Math.round(((uploadJob.framesProcessed || 0) / uploadJob.totalFrames) * 100))}%)
            </span>
          ) : !uploadJob.cancelling && uploadJob.framesProcessed > 0 ? (
            <span className="mono">{uploadJob.framesProcessed} frames</span>
          ) : null}
          {!uploadJob.cancelling && Number.isFinite(uploadJob.elapsedMs) && (
            <span className="mono">{formatDurationMs(uploadJob.elapsedMs)}</span>
          )}
          <button
            type="button"
            className="flyt-btn flyt-btn-cancel flyt-btn-cancel-compact"
            onClick={handleCancelRun}
            disabled={uploadJob.cancelling}
            aria-busy={uploadJob.cancelling}
          >
            <X size={13} />
            {uploadJob.cancelling ? 'Cancelling…' : 'Cancel'}
          </button>
        </div>
      )}

      <main>
        <div className={`flyt-page ${activeTab === 'upload' ? 'compact' : ''}`}>
          <div className={activeTab === 'dashboard' ? '' : 'hidden'}>
            <DashboardView
              data={data}
              stats={stats}
              heatmapData={heatmapData}
              events={events}
              reviewsByEventId={reviewsByEventId}
              runTimestamp={runTimestamp}
              mediaCacheBust={mediaCacheBust}
              runFps={runFps}
              totalFrames={totalFrames}
              activeEventId={activeEventId}
              isHistoricRun={isHistoricRun}
              runProvenance={runProvenance}
              videoAvailable={videoAvailable}
              trackingValidity={trackingValidity}
              onSeekEvent={setActiveEventId}
              onVerdict={handleVerdict}
            />
          </div>

          {activeTab === 'upload' && (
            <UploadView
              uploadJob={uploadJob}
              onFileSelect={handleFileSelect}
              onCancel={handleCancelRun}
            />
          )}

          {activeTab === 'runs' && (
            <div>
              <div className="flyt-title-row">
                <div>
                  <div className="flyt-eyeline">archived datasets</div>
                  <h1 className="flyt-h1">Run history</h1>
                  <p className="flyt-lead">
                    Click a run to load its CSV and events. Historic video is not archived.
                  </p>
                </div>
                {history.length > 0 && (
                  <button type="button" className="flyt-btn" onClick={clearHistoryServer}>
                    Clear history
                  </button>
                )}
              </div>

              <div className="flyt-history-table">
                <div className="flyt-history-head">
                  <div>Identifier</div>
                  <div>Date</div>
                  <div>Bouts</div>
                  <div>Avg prox</div>
                  <div>Duration</div>
                </div>
                {history.length === 0 ? (
                  <div className="flyt-empty">No runs in history yet. Complete a tracking job to populate this list.</div>
                ) : (
                  history.map((run) => (
                    <button
                      key={run.runId}
                      type="button"
                      className="flyt-history-row"
                      onClick={() => loadHistoricRun(run)}
                    >
                      <div className="flyt-mono" style={{ fontSize: 12, fontWeight: 650 }}>{run.runId}</div>
                      <div className="flyt-muted" style={{ fontSize: 12 }}>{formatRunDate(run.timestamp)}</div>
                      <div style={{ fontSize: 12 }}>{run.detectedBouts ?? 0} detected</div>
                      <div className="flyt-mono" style={{ fontSize: 12 }}>
                        {run.avgProximity != null ? `${run.avgProximity}px` : 'n/a'}
                      </div>
                      <div className="flyt-mono" style={{ fontSize: 12 }}>
                        {run.durationSec != null ? `${run.durationSec}s` : 'n/a'}
                      </div>
                    </button>
                  ))
                )}
              </div>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}


export default App;
