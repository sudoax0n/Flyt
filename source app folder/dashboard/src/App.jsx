import React, { useState, useEffect, useRef } from 'react';
import Papa from 'papaparse';
import { 
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, AreaChart, Area, 
  ScatterChart, Scatter, ZAxis
} from 'recharts';
import {
  Bug, Clock, UploadCloud, FolderKanban, Settings, Home, Sun, Moon,
  X, Check, DownloadCloud, FileText, ChevronDown,
} from 'lucide-react';

// Custom minimalist tooltip
const CustomTooltip = ({ active, payload, label }) => {
  if (active && payload && payload.length) {
    return (
      <div className="bg-white dark:bg-[#000000] border border-zinc-200 dark:border-zinc-800 p-3 shadow-md dark:shadow-none text-xs rounded-sm z-50">
        <p className="font-semibold text-zinc-900 dark:text-zinc-100 mb-2">Frame / Unit: {label}</p>
        <div className="flex flex-col gap-1">
          {payload.map((entry, index) => (
            <p key={index} className="flex justify-between gap-4">
              <span className="capitalize text-zinc-600 dark:text-zinc-400">{entry.name ? entry.name.replace('_', ' ') : 'Value'}:</span> 
              <span className="font-medium text-zinc-900 dark:text-white uppercase">{typeof entry.value === 'number' ? entry.value.toFixed(1) : entry.value}</span>
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

function formatTimeRange(startSec, endSec) {
  const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
  return `${fmt(startSec)} - ${fmt(endSec)}`;
}

function eventTypeLabel(type) {
  if (type === 'courtship_bout') return 'Courtship';
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
    const v1 = Number(r.fly1_speed_pxsec ?? r.fly1_speed ?? 0);
    const v2 = Number(r.fly2_speed_pxsec ?? r.fly2_speed ?? 0);
    const dist = Number(r.proximity_distance ?? 0);
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
  onSeekEvent,
  onVerdict,
}) {
  const videoRef = useRef(null);
  const [playingEventId, setPlayingEventId] = useState(null);
  const [jumpFrameInput, setJumpFrameInput] = useState('');
  const [currentFrame, setCurrentFrame] = useState(0);
  const [showLowConfidence, setShowLowConfidence] = useState(false);

  const maxFrame = totalFrames > 0 ? totalFrames - 1 : 0;
  const visibleEvents = showLowConfidence
    ? events
    : events.filter((e) => e.type !== 'low_confidence_segment');

  const handleVideoTimeUpdate = () => {
    const video = videoRef.current;
    const fps = runFps > 0 ? runFps : 30;
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
    const fps = runFps > 0 ? runFps : 30;
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

  return (
    <div className="flex flex-col gap-8 animate-in fade-in duration-300 pb-12">
      <header className="flex flex-col md:flex-row md:items-end justify-between gap-4">
        <div>
          <h2 className="text-3xl font-bold text-zinc-900 dark:text-white tracking-tight">Run Analytics</h2>
          <p className="text-zinc-500 text-sm mt-1">
            {runTimestamp ? (
              <>Run from <span className="font-mono text-zinc-800 dark:text-zinc-300 border border-zinc-200 dark:border-zinc-800 px-1.5 py-0.5 rounded ml-1 bg-zinc-50 dark:bg-zinc-900/50">{formatRunDate(runTimestamp)}</span></>
            ) : (
              'Upload and track a video to see results here.'
            )}
          </p>
        </div>
        <div className="flex gap-3">
           <button
             type="button"
             disabled={data.length === 0}
             onClick={() => exportPrismCsv(data, runFps)}
             className="no-print flex items-center gap-2 px-4 py-2 bg-white dark:bg-[#000000] border border-zinc-200 dark:border-zinc-800 rounded-sm text-xs font-semibold text-zinc-700 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-900 hover:text-zinc-900 dark:hover:text-white transition-colors shadow-sm dark:shadow-none disabled:opacity-40 disabled:cursor-not-allowed">
              <DownloadCloud size={14}/> Download CSV (Prism)
           </button>
           <button
             type="button"
             onClick={triggerPdfReport}
             className="no-print flex items-center gap-2 px-4 py-2 bg-zinc-900 dark:bg-white text-white dark:text-black rounded-sm text-xs font-bold hover:bg-zinc-800 dark:hover:bg-zinc-200 transition-colors shadow-sm dark:shadow-none">
              <FileText size={14}/> Export PDF Report
           </button>
        </div>
      </header>

      <div className="grid grid-cols-1 lg:grid-cols-4 gap-6">
        {/* Left Column (Video & Stats) */}
        <div className="lg:col-span-1 flex flex-col gap-6">
          
          <div className="no-print bg-white dark:bg-[#000000] border border-zinc-200 dark:border-zinc-800 rounded-sm overflow-hidden shadow-sm dark:shadow-none">
            <div className="p-3 border-b border-zinc-200 dark:border-zinc-800 flex items-center justify-between bg-zinc-50/50 dark:bg-[#050505]">
              <h3 className="font-semibold text-zinc-700 dark:text-zinc-300 flex items-center gap-2 text-[10px] uppercase tracking-widest">
                <Clock size={12} className="text-zinc-400"/>
                Tracking Feed
              </h3>
              {!isHistoricRun && (
                <span className="flex items-center gap-1.5 text-[10px] uppercase tracking-widest font-bold text-zinc-900 dark:text-white">
                  <span className="w-1.5 h-1.5 rounded-full bg-zinc-900 dark:bg-white animate-pulse"></span>
                  LIVE
                </span>
              )}
            </div>
            {isHistoricRun ? (
              <div className="w-full aspect-square bg-zinc-900 flex flex-col items-center justify-center text-center p-6 text-xs text-zinc-400">
                <p>Video preview not available</p>
                <p className="mt-1">Only data + events were archived for historic runs.</p>
              </div>
            ) : (
              <video
                ref={videoRef}
                controls
                onTimeUpdate={handleVideoTimeUpdate}
                className="w-full object-cover bg-black aspect-square"
                src={`/tracked.mp4?t=${mediaCacheBust}`}
              />
            )}
            <div className="p-3 border-t border-zinc-200 dark:border-zinc-800 bg-zinc-50/50 dark:bg-[#050505] flex flex-col gap-2">
              <div className="flex items-center gap-2 flex-wrap">
                <label htmlFor="jump-frame-input" className="text-[10px] font-bold uppercase tracking-widest text-zinc-500 shrink-0">
                  Frame
                </label>
                <input
                  id="jump-frame-input"
                  type="number"
                  min={0}
                  max={maxFrame}
                  value={jumpFrameInput}
                  onChange={(e) => setJumpFrameInput(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') handleJumpToFrame(e); }}
                  placeholder={`0–${maxFrame}`}
                  className="w-24 px-2 py-1.5 text-xs font-mono bg-white dark:bg-black border border-zinc-200 dark:border-zinc-700 rounded-sm text-zinc-900 dark:text-white outline-none focus:border-zinc-400 dark:focus:border-zinc-500"
                />
                <button
                  type="button"
                  onClick={handleJumpToFrame}
                  className="px-3 py-1.5 text-xs font-semibold bg-zinc-900 dark:bg-white text-white dark:text-black rounded-sm hover:bg-zinc-800 dark:hover:bg-zinc-200 transition-colors"
                >
                  Jump to frame
                </button>
              </div>
              <p className="text-[10px] text-zinc-400 font-mono">
                Current: {currentFrame} · {runFps > 0 ? runFps : 30} fps
              </p>
            </div>
          </div>

          <div className="bg-white dark:bg-[#000000] border border-zinc-200 dark:border-zinc-800 p-5 rounded-sm shadow-sm dark:shadow-none flex flex-col justify-between">
            <p className="text-[10px] text-zinc-500 font-bold tracking-widest uppercase mb-4">Courtship Bouts</p>
            <p className="text-3xl font-semibold text-zinc-900 dark:text-white tracking-tight">
              {stats.courtshipVerified}{' '}
              <span className="text-lg font-normal text-zinc-500">verified</span>
            </p>
            <p className="text-xs text-zinc-400 mt-1">
              {stats.courtshipDetected} detected (human review)
            </p>
          </div>
          
          <div className="bg-white dark:bg-[#000000] border border-zinc-200 dark:border-zinc-800 p-5 rounded-sm shadow-sm dark:shadow-none flex flex-col justify-between">
            <p className="text-[10px] text-zinc-500 font-bold tracking-widest uppercase mb-4">Total Sleep Time</p>
            <p className="text-3xl font-semibold text-zinc-900 dark:text-white tracking-tight">
               {stats.sleepTime} <span className="text-xs font-normal text-zinc-400">sec</span>
            </p>
            <p className="text-[9px] text-zinc-500 mt-1">≈ low activity &gt;5s (ad-hoc)</p>
          </div>

        </div>

        {/* Right Column (Charts) */}
        <div className="lg:col-span-3 grid grid-cols-2 gap-6">
          
          <div className="col-span-2 md:col-span-1 bg-white dark:bg-[#000000] border border-zinc-200 dark:border-zinc-800 rounded-sm p-6 h-[260px] flex flex-col shadow-sm dark:shadow-none relative overflow-hidden">
             <h3 className="text-[10px] font-bold text-zinc-600 dark:text-zinc-400 mb-2 uppercase tracking-widest z-10 w-full">
                Spatial Heatmap
             </h3>
             <p className="text-[10px] text-zinc-500 mb-2 z-10 w-full">Arena density (XY coords)</p>
             <div className="flex-1 w-full absolute inset-0 pt-16 px-4 pb-4">
                <ResponsiveContainer width="100%" height="100%">
                  <ScatterChart margin={{ top: 0, right: 0, left: -30, bottom: 0 }}>
                    <XAxis type="number" dataKey="x" name="X" opacity={0} domain={['dataMin', 'dataMax']} />
                    <YAxis type="number" dataKey="y" name="Y" opacity={0} domain={['dataMin', 'dataMax']} reversed={true} />
                    <ZAxis type="number" range={[10, 20]} />
                    <Scatter data={heatmapData} fill="currentColor" className="text-zinc-900 dark:text-zinc-500" fillOpacity={0.06} />
                  </ScatterChart>
                </ResponsiveContainer>
             </div>
          </div>

          <div className="col-span-2 md:col-span-1 bg-white dark:bg-[#000000] border border-zinc-200 dark:border-zinc-800 rounded-sm p-6 h-[260px] flex flex-col shadow-sm dark:shadow-none">
             <h3 className="text-[10px] font-bold text-zinc-600 dark:text-zinc-400 mb-6 uppercase tracking-widest">
                Velocity (px/sec)
             </h3>
             <div className="flex-1 w-full relative">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={data} margin={{ top: 5, right: 0, left: -20, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="currentColor" className="text-zinc-200 dark:text-zinc-800/40" vertical={false} />
                    <XAxis dataKey="frame" stroke="currentColor" className="text-zinc-300 dark:text-zinc-700" tick={{fill: '#a1a1aa', fontSize: 10}} tickLine={false} axisLine={false} />
                    <YAxis stroke="currentColor" className="text-zinc-300 dark:text-zinc-700" tick={{fill: '#a1a1aa', fontSize: 10}} tickLine={false} axisLine={false} />
                    <Tooltip cursor={{stroke: '#a1a1aa', strokeWidth: 1, strokeDasharray: '3 3'}} content={<CustomTooltip />} />
                    <Line type="monotone" dot={false} dataKey="fly1_speed_pxsec" name="Fly 1 Velocity" stroke="currentColor" className="text-zinc-900 dark:text-zinc-300" strokeWidth={1.5} />
                    <Line type="monotone" dot={false} dataKey="fly2_speed_pxsec" name="Fly 2 Velocity" stroke="currentColor" className="text-zinc-400 dark:text-zinc-600" strokeWidth={1} strokeDasharray="3 3"/>
                  </LineChart>
                </ResponsiveContainer>
             </div>
          </div>

          <div className="col-span-2 bg-white dark:bg-[#000000] border border-zinc-200 dark:border-zinc-800 rounded-sm p-6 h-[260px] flex flex-col shadow-sm dark:shadow-none">
             <h3 className="text-[10px] font-bold text-zinc-600 dark:text-zinc-400 mb-6 uppercase tracking-widest flex items-center justify-between">
                Inter-Fly Proximity Distance
             </h3>
             <div className="flex-1 w-full relative">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={data} margin={{ top: 5, right: 0, left: -20, bottom: 0 }}>
                    <defs>
                      <linearGradient id="colorProx" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="currentColor" stopOpacity={0.15}/>
                        <stop offset="95%" stopColor="currentColor" stopOpacity={0}/>
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="currentColor" className="text-zinc-200 dark:text-zinc-800/40" vertical={false} />
                    <XAxis dataKey="frame" stroke="currentColor" className="text-zinc-300 dark:text-zinc-700" tick={{fill: '#a1a1aa', fontSize: 10}} tickLine={false} axisLine={false} />
                    <YAxis stroke="currentColor" className="text-zinc-300 dark:text-zinc-700" tick={{fill: '#a1a1aa', fontSize: 10}} tickLine={false} axisLine={false} />
                    <Tooltip cursor={{stroke: '#a1a1aa', strokeWidth: 1, strokeDasharray: '3 3'}} content={<CustomTooltip />} />
                    <Area type="step" dot={false} dataKey="proximity_distance" stroke="currentColor" className="text-zinc-900 dark:text-zinc-300" strokeWidth={1.5} fillOpacity={1} fill="url(#colorProx)" />
                  </AreaChart>
                </ResponsiveContainer>
             </div>
          </div>
          
        </div>
      </div>

      <div className="bg-white dark:bg-[#000000] border border-zinc-200 dark:border-zinc-800 rounded-sm shadow-sm dark:shadow-none overflow-hidden">
        <div className="p-4 border-b border-zinc-200 dark:border-zinc-800 bg-zinc-50/50 dark:bg-[#050505] flex items-center justify-between gap-3 flex-wrap">
          <h3 className="font-semibold text-zinc-700 dark:text-zinc-300 text-[10px] uppercase tracking-widest">
            Event Verification
          </h3>
          <div className="flex items-center gap-3">
            <label className="flex items-center gap-1.5 text-[10px] text-zinc-500 uppercase tracking-widest cursor-pointer select-none">
              <input
                type="checkbox"
                checked={showLowConfidence}
                onChange={(e) => setShowLowConfidence(e.target.checked)}
                className="rounded border-zinc-300 dark:border-zinc-600"
              />
              Show low confidence
            </label>
            <span className="text-[10px] text-zinc-500 uppercase tracking-widest">
              {visibleEvents.length} shown
            </span>
          </div>
        </div>
        {visibleEvents.length === 0 ? (
          <div className="p-8 text-center text-sm text-zinc-500 dark:text-zinc-400">
            No events to verify. Upload and track a video to generate suspected courtship bouts.
          </div>
        ) : (
          <div className="divide-y divide-zinc-200 dark:divide-zinc-800 max-h-[320px] overflow-y-auto">
            {visibleEvents.map((event) => {
              const verdict = getVerdict(event.id);
              const isHighlighted = playingEventId === event.id || activeEventId === event.id;
              return (
                <div
                  key={event.id}
                  onClick={() => handleEventClick(event)}
                  className={`p-4 cursor-pointer transition-colors ${
                    isHighlighted
                      ? 'bg-zinc-100 dark:bg-zinc-900/80'
                      : 'hover:bg-zinc-50 dark:hover:bg-zinc-900/40'
                  }`}
                >
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1.5 flex-wrap">
                        <span className="text-[10px] font-bold uppercase tracking-widest px-2 py-0.5 rounded-sm border border-zinc-200 dark:border-zinc-700 text-zinc-600 dark:text-zinc-300">
                          {eventTypeLabel(event.type)}
                        </span>
                        <span
                          className={`text-[10px] font-bold uppercase tracking-widest px-2 py-0.5 rounded-sm ${
                            verdict === 'confirmed'
                              ? 'bg-emerald-50 dark:bg-emerald-950/30 text-emerald-700 dark:text-emerald-400 border border-emerald-200 dark:border-emerald-900/50'
                              : verdict === 'rejected'
                                ? 'bg-red-50 dark:bg-red-950/30 text-red-600 dark:text-red-400 border border-red-200 dark:border-red-900/50'
                                : 'bg-zinc-100 dark:bg-zinc-900 text-zinc-500 border border-zinc-200 dark:border-zinc-700'
                          }`}
                        >
                          {verdict}
                        </span>
                        <span className="font-mono text-[10px] text-zinc-400">{event.id}</span>
                      </div>
                      <p className="text-sm font-medium text-zinc-900 dark:text-white">
                        {formatTimeRange(event.start_time_sec, event.end_time_sec)}
                        <span className="text-zinc-400 font-normal ml-2">
                          ({event.duration_sec.toFixed(1)}s)
                        </span>
                      </p>
                      <p className="text-[11px] text-zinc-500 mt-1">
                        Frames {event.start_frame}–{event.end_frame} · mean prox {event.mean_proximity_px}px
                      </p>
                    </div>
                    <div className="flex gap-2 shrink-0" onClick={(e) => e.stopPropagation()}>
                      <button
                        type="button"
                        onClick={(e) => handleVerdictClick(e, event.id, 'confirmed')}
                        className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-sm border transition-colors ${
                          verdict === 'confirmed'
                            ? 'bg-emerald-600 text-white border-emerald-600'
                            : 'bg-white dark:bg-black border-zinc-200 dark:border-zinc-700 text-zinc-700 dark:text-zinc-300 hover:border-emerald-500'
                        }`}
                      >
                        <Check size={14} /> Confirm
                      </button>
                      <button
                        type="button"
                        onClick={(e) => handleVerdictClick(e, event.id, 'rejected')}
                        className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-sm border transition-colors ${
                          verdict === 'rejected'
                            ? 'bg-red-600 text-white border-red-600'
                            : 'bg-white dark:bg-black border-zinc-200 dark:border-zinc-700 text-zinc-700 dark:text-zinc-300 hover:border-red-500'
                        }`}
                      >
                        <X size={14} /> Reject
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function UploadView({ uploadJob, onFileSelect }) {
  const fileInputRef = useRef(null);
  const isProcessing = uploadJob.active;

  const handleFileChange = (e) => {
    if (!e.target.files || e.target.files.length === 0) return;
    onFileSelect(e.target.files[0]);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  return (
    <div className="flex flex-col items-center justify-center h-full animate-in fade-in duration-300">
      {isProcessing ? (
        <div className="flex flex-col items-center justify-center gap-5 max-w-sm">
          <div className="w-6 h-6 rounded-full border-2 border-zinc-900 dark:border-white border-r-transparent animate-spin" />
          <p className="text-sm font-medium text-zinc-900 dark:text-zinc-100 tracking-tight text-center">
            {uploadJob.progress || 'Initializing...'}
          </p>
          {uploadJob.framesProcessed > 0 && (
            <div className="flex items-center gap-4 text-[10px] uppercase tracking-widest text-zinc-500">
              <span className="font-mono font-bold text-zinc-900 dark:text-white text-xs">{uploadJob.framesProcessed}</span>
              frames tracked
            </div>
          )}
        </div>
      ) : (
        <div className="w-full max-w-lg flex flex-col items-center">

            {uploadJob.error && (
              <div className="w-full mb-6 p-4 bg-red-50 dark:bg-red-950/20 border border-red-200 dark:border-red-900/50 rounded-sm">
                <p className="text-xs font-semibold text-red-600 dark:text-red-400">{uploadJob.error}</p>
              </div>
            )}
            


            <div
              onClick={() => fileInputRef.current?.click()}
              className="bg-zinc-50/50 dark:bg-[#050505]/50 border border-dashed border-zinc-300 dark:border-zinc-800 rounded-sm w-full p-16 flex flex-col items-center justify-center transition-colors shadow-sm dark:shadow-none hover:bg-zinc-50 dark:hover:bg-[#111] cursor-pointer group"
            >
              <UploadCloud size={32} className="text-zinc-400 dark:text-zinc-600 mb-4 group-hover:text-zinc-900 dark:group-hover:text-white transition-colors" />
              <h3 className="text-sm font-semibold tracking-tight text-zinc-900 dark:text-zinc-100 mb-1">Select video file</h3>
              <p className="text-[11px] text-zinc-500 text-center uppercase tracking-wider">MP4 up to 10GB</p>
              <input type="file" ref={fileInputRef} onChange={handleFileChange} className="hidden" accept=".mp4,.avi,.mov" />
            </div>
            
        </div>
      )}
    </div>
  );
}

function SettingsModal({ isOpen, onClose, settings, onApply }) {
  const [draft, setDraft] = React.useState(settings);
  const [showAdvanced, setShowAdvanced] = React.useState(false);

  // Re-sync draft when the modal opens or saved settings change.
  useEffect(() => {
    if (isOpen) setDraft(settings);
  }, [isOpen, settings]);

  if (!isOpen) return null;

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
    <div className="fixed inset-0 z-50 flex items-center justify-center animate-in fade-in duration-200 bg-zinc-900/20 dark:bg-[#000000]/80 backdrop-blur-sm" onClick={onClose}>
      <div className="bg-white dark:bg-[#000000] border border-zinc-200 dark:border-zinc-800 w-full max-w-sm p-8 rounded-sm shadow-2xl relative" onClick={e => e.stopPropagation()}>
        <button onClick={onClose} className="absolute top-4 right-4 text-zinc-400 hover:text-zinc-900 dark:hover:text-white transition-colors">
          <X size={16} />
        </button>
        <h2 className="text-xl font-bold text-zinc-900 dark:text-white mb-1">Tracker Settings</h2>
        <p className="text-[11px] text-zinc-500 mb-6">Applied on the next upload. Defaults match the pitch baseline.</p>

        <div className="space-y-6">
          <div>
            <label className="text-[10px] font-bold text-zinc-500 dark:text-zinc-400 uppercase tracking-widest block mb-2">Min contour area (px²)</label>
            <p className="text-[10px] text-zinc-400 dark:text-zinc-500 mb-2">Ignore foreground blobs smaller than this (noise / debris).</p>
            <input type="number" min={0} value={draft.minArea} onChange={setField('minArea')}
              className="w-full bg-zinc-50 dark:bg-[#050505] border border-zinc-200 dark:border-zinc-800 text-zinc-900 dark:text-zinc-300 text-xs px-3 py-2 rounded-sm outline-none focus:border-zinc-400 dark:focus:border-zinc-500" />
          </div>

          <div>
            <label className="text-[10px] font-bold text-zinc-500 dark:text-zinc-400 uppercase tracking-widest block mb-2">Proximity threshold (px)</label>
            <p className="text-[10px] text-zinc-400 dark:text-zinc-500 mb-2">Centroid distance that defines a courtship bout.</p>
            <input type="number" min={0} value={draft.proximityThreshold} onChange={setField('proximityThreshold')}
              className="w-full bg-zinc-50 dark:bg-[#050505] border border-zinc-200 dark:border-zinc-800 text-zinc-900 dark:text-zinc-300 text-xs px-3 py-2 rounded-sm outline-none focus:border-zinc-400 dark:focus:border-zinc-500" />
          </div>

          <div>
            <label className="text-[10px] font-bold text-zinc-500 dark:text-zinc-400 uppercase tracking-widest block mb-2">Bout min frames</label>
            <p className="text-[10px] text-zinc-400 dark:text-zinc-500 mb-2">Consecutive proximity frames required for a bout (~3s at 30fps = 90).</p>
            <input type="number" min={1} value={draft.boutMinFrames} onChange={setField('boutMinFrames')}
              className="w-full bg-zinc-50 dark:bg-[#050505] border border-zinc-200 dark:border-zinc-800 text-zinc-900 dark:text-zinc-300 text-xs px-3 py-2 rounded-sm outline-none focus:border-zinc-400 dark:focus:border-zinc-500" />
          </div>

          <button type="button" onClick={() => setShowAdvanced((s) => !s)}
            className="text-[10px] font-semibold text-zinc-500 hover:text-zinc-900 dark:hover:text-white uppercase tracking-widest flex items-center gap-1">
            <ChevronDown size={12} className={`transition-transform ${showAdvanced ? 'rotate-180' : ''}`} />
            Advanced
          </button>

          {showAdvanced && (
            <div>
              <label className="text-[10px] font-bold text-zinc-500 dark:text-zinc-400 uppercase tracking-widest block mb-2">Max contour area (px²)</label>
              <p className="text-[10px] text-zinc-400 dark:text-zinc-500 mb-2">Upper area bound (0 = no limit). Pitch uses 0; raise to ignore the cotton plug.</p>
              <input type="number" min={0} value={draft.maxArea} onChange={setField('maxArea')}
                className="w-full bg-zinc-50 dark:bg-[#050505] border border-zinc-200 dark:border-zinc-800 text-zinc-900 dark:text-zinc-300 text-xs px-3 py-2 rounded-sm outline-none focus:border-zinc-400 dark:focus:border-zinc-500" />
            </div>
          )}
        </div>

        <div className="mt-8 flex gap-2">
          <button onClick={resetDefaults}
            className="px-4 py-2 text-xs font-semibold bg-transparent border border-zinc-200 dark:border-zinc-800 text-zinc-600 dark:text-zinc-400 hover:bg-zinc-50 dark:hover:bg-zinc-900 rounded-sm transition-colors">
            Reset
          </button>
          <button onClick={apply}
            className="flex-1 bg-zinc-900 dark:bg-white text-white dark:text-black hover:bg-zinc-800 dark:hover:bg-zinc-200 px-5 py-2 text-xs font-bold rounded-sm transition-colors shadow-sm dark:shadow-none">
            Apply Configuration
          </button>
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
  const [activeEventId, setActiveEventId] = useState(null);
  const [activeTab, setActiveTab] = useState('dashboard');
  const [isDark, setIsDark] = useState(true);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  // Tracker settings — defaults match the pitch baseline. Sent to /api/upload
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
    progress: '',
    framesProcessed: 0,
    error: null,
  });
  const pollRef = useRef(null);
  const loadGenerationRef = useRef(0);

  const computeCourtshipStats = (eventList, reviews) => {
    const courtshipEvents = eventList.filter((e) => e.type === 'courtship_bout');
    const verified = courtshipEvents.filter(
      (e) => reviews[e.id]?.verdict === 'confirmed'
    ).length;
    return { detected: courtshipEvents.length, verified };
  };

  const loadEventsAndVerification = async (cacheBust = Date.now(), generation = loadGenerationRef.current, runId = null) => {
    let eventList = [];
    const reviews = {};
    let fps = 30;
    let frames = 0;

    if (!runId) {
      try {
        const metaRes = await fetch(`/run_metadata.json?t=${cacheBust}`, { cache: 'no-store' });
        if (metaRes.ok) {
          const meta = await metaRes.json();
          if (meta.timestamp) setRunTimestamp(meta.timestamp);
          if (meta.fps) fps = meta.fps;
        }
      } catch { /* metadata optional */ }
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

    if (!runId) {
      try {
        const verRes = await fetch(`/api/verification?t=${cacheBust}`, { cache: 'no-store' });
        if (verRes.ok) {
          const verData = await verRes.json();
          (verData.reviews || []).forEach((r) => {
            reviews[r.event_id] = r;
          });
        }
      } catch { /* keep empty reviews */ }
    }

    if (generation !== loadGenerationRef.current) return { fps: 30 };

    if (frames > 0) setTotalFrames(frames);
    setRunFps(fps);
    setEvents(eventList);
    setReviewsByEventId(reviews);
    setStats((prev) => {
      const { detected, verified } = runId
        ? { detected: eventList.filter((e) => e.type === 'courtship_bout').length, verified: 0 }
        : computeCourtshipStats(eventList, reviews);
      return { ...prev, courtshipDetected: detected, courtshipVerified: verified };
    });
    return { fps, frames };
  };

  const loadData = (cacheBust = Date.now(), generation = loadGenerationRef.current, customPath = null, fps = 30) => new Promise((resolve) => {
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
          // Average proximity only over frames where flies are separate (exclude merged/occluded where proximity=0 by design)
          if (row.proximity_distance != null && !row.occlusion_flag) {
            totalProx += row.proximity_distance;
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
        resolve(parsedData.length);
      },
      error: () => resolve(0),
    });
  });

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

  const loadHistory = async (cacheBust = Date.now()) => {
    try {
      const res = await fetch(`/api/history?t=${cacheBust}`, { cache: 'no-store' });
      if (!res.ok) return;
      const hist = await res.json();
      setHistory(Array.isArray(hist.runs) ? hist.runs : []);
    } catch { /* history optional */ }
  };

  // Load a past run's snapshot (data.csv + events.json from public/history/<runId>/)
  // into the active dashboard. Video for past runs is not snapshotted — clear it
  // so the player doesn't show a stale frame.
  const loadHistoricRun = async (runId) => {
    const generation = ++loadGenerationRef.current;
    const cacheBust = Date.now();
    setMediaCacheBust(cacheBust);
    setRunTimestamp(new Date().toISOString());
    setIsHistoricRun(true);
    try {
      // Load events first to get accurate fps (avoids stale state) for sleep + pxsec normalization
      const eventResult = await loadEventsAndVerification(cacheBust, generation, runId);
      const historicFps = (eventResult && eventResult.fps > 0) ? eventResult.fps : 30;
      await loadData(cacheBust, generation, `/history/${runId}/data.csv`, historicFps);
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

  const loadAll = async (cacheBust = Date.now()) => {
    const generation = ++loadGenerationRef.current;
    setMediaCacheBust(cacheBust);
    setIsHistoricRun(false);
    // Load events first to get accurate fps for loadData (sleep calc + any legacy pxsec normalization)
    const eventsResult = await loadEventsAndVerification(cacheBust, generation);
    const currentFps = (eventsResult && eventsResult.fps > 0) ? eventsResult.fps : runFps;
    await Promise.all([
      loadData(cacheBust, generation, null, currentFps),
      loadHistory(cacheBust),
    ]);
  };

  useEffect(() => {
    loadAll();
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, []);

  useEffect(() => {
    if (!uploadJob.active) return undefined;

    const poll = async () => {
      try {
        const statusRes = await fetch(`/api/status?t=${Date.now()}`, { cache: 'no-store' });
        const status = await statusRes.json();

        setUploadJob((prev) => ({
          ...prev,
          progress: status.progress || prev.progress,
          framesProcessed: status.framesProcessed || 0,
        }));

        if (status.status === 'done') {
          if (pollRef.current) clearInterval(pollRef.current);
          pollRef.current = null;
          setUploadJob({ active: false, progress: 'Loading results...', framesProcessed: 0, error: null });
          await loadAll(Date.now());
          setActiveTab('dashboard');
        } else if (status.status === 'error') {
          if (pollRef.current) clearInterval(pollRef.current);
          pollRef.current = null;
          setUploadJob({
            active: false,
            progress: '',
            framesProcessed: 0,
            error: status.error || 'Tracking failed',
          });
        }
      } catch { /* ignore transient poll errors */ }
    };

    pollRef.current = setInterval(poll, 800);
    poll();
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
      pollRef.current = null;
    };
  }, [uploadJob.active]);

  const handleFileSelect = async (file) => {
    if (pollRef.current) clearInterval(pollRef.current);
    loadGenerationRef.current += 1;
    setActiveTab('upload');
    setUploadJob({
      active: false,
      progress: 'Uploading video...',
      framesProcessed: 0,
      error: null,
    });

    const formData = new FormData();
    formData.append('video', file);
    // Settings UI → backend CLI args (Task A / K-04)
    formData.append('minArea', settings.minArea);
    formData.append('maxArea', settings.maxArea);
    formData.append('proximityThreshold', settings.proximityThreshold);
    formData.append('boutMinFrames', settings.boutMinFrames);

    try {
      const response = await fetch('/api/upload', { method: 'POST', body: formData });
      if (!response.ok) {
        const errData = await response.json().catch(() => ({}));
        throw new Error(errData.error || 'Upload failed');
      }
      setUploadJob({
        active: true,
        progress: 'Starting tracker...',
        framesProcessed: 0,
        error: null,
      });
    } catch (err) {
      setUploadJob({
        active: false,
        progress: '',
        framesProcessed: 0,
        error: err.message || 'Upload failed',
      });
    }
  };

  return (
    <div className={`h-screen font-sans antialiased overflow-hidden transition-colors duration-300 ${isDark ? 'dark bg-[#000000] text-zinc-100' : 'bg-zinc-50 text-zinc-900'}`}>

      <SettingsModal
        isOpen={isSettingsOpen}
        onClose={() => setIsSettingsOpen(false)}
        settings={settings}
        onApply={setSettings}
      />

      <div className="flex h-full w-full">
        {/* Sidebar */}
        <aside className="w-56 bg-[#F4F4F5] dark:bg-[#000000] border-r border-zinc-200 dark:border-zinc-800 flex flex-col flex-shrink-0 z-10 transition-colors duration-300">
          <div className="h-16 flex items-center px-5 border-b border-zinc-200 dark:border-zinc-800">
             <div className="w-5 h-5 bg-zinc-900 dark:bg-white flex items-center justify-center mr-2 rounded-[2px] shadow-sm dark:shadow-none">
                <Bug size={14} className="text-white dark:text-black" />
             </div>
             <span className="font-bold text-sm tracking-tight text-zinc-900 dark:text-white">Flyt</span>
          </div>

          <nav className="p-4 flex-1 flex flex-col gap-1.5">
              <button
                type="button"
                onClick={() => setActiveTab('dashboard')}
                className={`flex items-center gap-2.5 px-3 py-2 rounded-sm text-[13px] font-medium transition-colors ${activeTab === 'dashboard' ? 'bg-white dark:bg-zinc-900 text-zinc-900 dark:text-white shadow-sm border border-zinc-200 dark:border-zinc-800' : 'text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-300 hover:bg-white/50 dark:hover:bg-zinc-900/50 border border-transparent'}`}
              >
                <Home size={16} /> Dashboard
              </button>
              <button
                type="button"
                onClick={() => setActiveTab('upload')}
                className={`flex items-center gap-2.5 px-3 py-2 rounded-sm text-[13px] font-medium transition-colors ${activeTab === 'upload' ? 'bg-white dark:bg-zinc-900 text-zinc-900 dark:text-white shadow-sm border border-zinc-200 dark:border-zinc-800' : 'text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-300 hover:bg-white/50 dark:hover:bg-zinc-900/50 border border-transparent'}`}
              >
                <UploadCloud size={16} /> Analyze Output
              </button>
              <button
                type="button"
                onClick={() => setActiveTab('runs')}
                className={`flex items-center gap-2.5 px-3 py-2 rounded-sm text-[13px] font-medium transition-colors ${activeTab === 'runs' ? 'bg-white dark:bg-zinc-900 text-zinc-900 dark:text-white shadow-sm border border-zinc-200 dark:border-zinc-800' : 'text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-300 hover:bg-white/50 dark:hover:bg-zinc-900/50 border border-transparent'}`}
              >
                <FolderKanban size={16} /> History
              </button>
          </nav>
          
          <div className="p-4 border-t border-zinc-200 dark:border-zinc-800 flex justify-between items-center">
              <button 
                onClick={() => setIsSettingsOpen(true)}
                className="p-1.5 text-zinc-500 hover:text-zinc-900 dark:hover:text-white rounded-sm hover:bg-zinc-200 dark:hover:bg-zinc-900 transition-colors">
                 <Settings size={16} />
              </button>
              <button 
                onClick={() => setIsDark(!isDark)}
                className="p-1.5 text-zinc-500 hover:text-zinc-900 dark:hover:text-white rounded-sm hover:bg-zinc-200 dark:hover:bg-zinc-900 transition-colors">
                 {isDark ? <Sun size={16} /> : <Moon size={16} />}
              </button>
          </div>
        </aside>

        {/* Main Content Area */}
        <main className="flex-1 overflow-y-auto bg-zinc-50 dark:bg-[#000000] transition-colors duration-300 relative">
          {uploadJob.active && (
            <div className="sticky top-0 z-20 bg-amber-50 dark:bg-amber-950/40 border-b border-amber-200 dark:border-amber-900/50 px-6 py-2 text-xs text-amber-800 dark:text-amber-200">
              {uploadJob.progress}
              {uploadJob.framesProcessed > 0 && (
                <span className="font-mono ml-2">{uploadJob.framesProcessed} frames</span>
              )}
            </div>
          )}
          <div className="max-w-6xl mx-auto p-8 lg:p-10">
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
                onSeekEvent={setActiveEventId}
                onVerdict={handleVerdict}
              />
            </div>
            {activeTab === 'upload' && (
              <UploadView uploadJob={uploadJob} onFileSelect={handleFileSelect} />
            )}
            {activeTab === 'runs' && (
              <div className="animate-in fade-in duration-300">
                <header className="mb-6 flex justify-between items-center">
                  <h2 className="text-2xl font-bold text-zinc-900 dark:text-white tracking-tight">Run History</h2>
                  {history.length > 0 && (
                    <button
                      onClick={clearHistoryServer}
                      className="px-3 py-1.5 text-xs font-semibold bg-red-50 text-red-600 dark:bg-red-950/30 dark:text-red-400 hover:bg-red-100 dark:hover:bg-red-900/40 rounded-sm transition-colors border border-red-200 dark:border-red-900/50">
                       Clear History
                    </button>
                  )}
                </header>
                <div className="w-full bg-white dark:bg-[#000000] border border-zinc-200 dark:border-zinc-800 rounded-sm overflow-hidden shadow-sm dark:shadow-none">
                   <div className="grid grid-cols-5 p-4 border-b border-zinc-200 dark:border-zinc-800 text-[10px] font-bold text-zinc-500 uppercase tracking-widest bg-zinc-50 dark:bg-[#050505]">
                      <div>Identifier</div>
                      <div>Date</div>
                      <div>Bouts</div>
                      <div>Avg Prox</div>
                      <div>Duration</div>
                   </div>
                   {history.length === 0 ? (
                     <div className="p-8 text-center text-sm text-zinc-500 dark:text-zinc-400">No runs found in history. Run a tracking job to populate this list.</div>
                   ) : (
                     history.map((run) => (
                       <div
                         key={run.runId}
                         onClick={() => loadHistoricRun(run.runId)}
                         className="grid grid-cols-5 p-4 border-b border-zinc-200 dark:border-zinc-800 text-sm items-center hover:bg-zinc-50 dark:hover:bg-zinc-900/50 cursor-pointer transition-colors group last:border-b-0">
                          <div className="font-mono text-xs font-semibold text-zinc-900 dark:text-white">{run.runId}</div>
                          <div className="text-zinc-500 dark:text-zinc-400 text-xs">{formatRunDate(run.timestamp)}</div>
                          <div>
                            <span className="flex items-center gap-1.5">
                              <Check size={14} className="text-zinc-900 dark:text-white" />
                              <span className="text-xs font-medium text-zinc-900 dark:text-zinc-300">{run.detectedBouts ?? 0} detected</span>
                            </span>
                          </div>
                          <div className="text-zinc-500 dark:text-zinc-400 text-xs font-mono">{run.avgProximity != null ? `${run.avgProximity}px` : '—'}</div>
                          <div className="text-zinc-500 dark:text-zinc-400 text-xs font-mono">{run.durationSec != null ? `${run.durationSec}s` : '—'}</div>
                       </div>
                     ))
                   )}
                </div>
                <p className="mt-3 text-[10px] text-zinc-400 uppercase tracking-widest">Click any run to load its dataset into the dashboard. Video is not archived for past runs.</p>
              </div>
            )}
          </div>
        </main>
      </div>
    </div>
  );
}

export default App;
