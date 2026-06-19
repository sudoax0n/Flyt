# Flyt Changelog

This file is the **single source of truth** for detailed change history.

Use the format:
```
## YYYY-MM-DD — Agent / Model
### Category
- Bullet points of changes, fixes, analysis, decisions.
```

Previous detailed tables lived inside `AGENTS.md` and `gemini.md` (they must stay in sync for other content). From 2026-06-18 forward, new work goes here.

---

## 2026-06-18 — Grok 4.3

### Codebase Analysis & Direction Review
- Full review of the Flyt PoC against stated goals (local CPU-first, transparent deterministic tracking + human-verifiable annotation system for behavioral biology labs).
- Confirmed strong alignment on:
  - Pitch parity discipline (core columns untouched).
  - Human-in-the-loop verification for courtship.
  - Settings → CLI wiring, history, exports, cross-platform support (recent z-code tasks).
- Noted remaining areas:
  - Velocity chart was incomplete after speed normalization.
  - Minor runtime bug in history clearing.
  - Dead UI in upload flow.
  - Sleep metric still ad-hoc (flagged for improvement).
  - Long-term: identity continuity during occlusion remains deferred (correct decision).
- Verdict: On the right track for a publication-oriented PoC. Dashboard layer is maturing nicely on top of a deliberately simple auditable tracker.

### Fixes & Improvements
- **Velocity chart (K-16)**: 
  - Changed Recharts `Line` dataKeys from `fly1_speed`/`fly2_speed` to `fly1_speed_pxsec`/`fly2_speed_pxsec`.
  - Added legacy column normalization in `loadData()` so old CSVs and historic snapshots render correctly (30 fps fallback).
- **History clear crash (K-17)**:
  - Removed stray `setHistoryCleared(true)` call in `clearHistoryServer` (state was never declared).
- **UploadView cleanup**:
  - Removed non-functional "Output Selection" and "Camera Perspective" controls (and their unused state). Upload screen is now simpler and focused.
- **Sleep metric improvement**:
  - Made calculation time-based instead of hardcoded frame counts.
  - `loadData()` now accepts an optional `fps` parameter (defaults to 30).
  - Uses `effectiveFps` and `sleepThresholdFrames = round(5 * effectiveFps)`.
  - Updated callers (`loadAll`, `loadHistoricRun`) to pass real fps when known.
  - Added small "≈ low activity >5s (ad-hoc)" note under the sleep card for transparency.
- **Documentation**:
  - Updated Known Issues tables (added K-16, K-17 as resolved) in both agent guides.
  - Updated K-08 note for chart completion.
  - Created this `changelog.md`.
  - Cleaned changelog sections in `AGENTS.md` and `gemini.md` (see below).
- Verified: `npm run build` succeeds cleanly.

### Additional Refinements (same session)
- Consolidated fps handling in `loadData()`: legacy px/sec normalization now uses the run's `effectiveFps` instead of hard 30.
- Extracted magic `activity_level < 10` into named `LOW_ACTIVITY_THRESHOLD` constant with explanatory comment.
- Fixed potential stale `runFps` state when loading historic runs for sleep/pxsec calculations:
  - Made `loadEventsAndVerification` and `loadEventsAndVerificationForRun` return `{fps, ...}`.
  - Updated `loadAll()` and `loadHistoricRun()` to use returned fps before calling `loadData()`.
- Improved load order in `loadAll()` (events first) for correct fps on initial data load.
- **Historic run video handling**: Added `isHistoricRun` state + conditional placeholder in DashboardView instead of showing stale `tracked.mp4`. Header "LIVE" badge hidden for archives. Seeking still works for data/events.
- **Avg proximity consistency**:
  - Client `loadData()` now averages proximity only over non-occluded frames (excludes 0s from merges).
  - Server `readCsvAvgProximity` updated to match (uses `occlusion_flag` when present).
- Extracted more constants and cleaned fps/legacy logic.
- All changes preserve backward compatibility and pitch parity where relevant.
- BUILD SUCCESS verified after each batch.

### Agent Docs Housekeeping
- Confirmed date + model name (`2026-06-18 | Grok 4.3`) used in entries.
- Centralized detailed logging to `changelog.md`.
- Added pointers in `AGENTS.md` and `gemini.md`.

---

## 2026-06-17 — z-code
**Tasks A/B/C/D/E shipped.**
- K-04: Settings UI → backend CLI args
- K-08: px/sec speed columns (parity-safe)
- K-12: Platform-agnostic python path
- K-07: Prism CSV export + PDF print support
- K-06: Real run history (JSON snapshots + reload)

Frontend builds clean. Tracker parity note for later verification.

---

## 2026-06-15 — Grok
- Phase 3: suspected events (`events.json`), verification API + panel, verified vs detected bout stats.
- Reverted Phase 2 ToxId to pitch core.
- Added `handoff-current.md`, `START.bat`.
- Verification UX fixes, jump-to-frame UI, courtship-only filter.
- Docs synced.

---

## 2026-06-14 — Grok
- Initial `AGENTS.md` + gemini sync.
- Phase 1: H.264 transcoding, frame sync, area CLI flags.
- Phase 2 (later reverted): experimental ToxId + scipy.

---

## Earlier History
See the historical table that used to live at the bottom of `AGENTS.md` / `gemini.md` (pre-2026-06-18 migration) for the very early agent entries if needed.

---

**Note for agents:** When you ship meaningful work, append a dated section here (with your model/agent name). Also keep the high-level "How to update" guidance inside `AGENTS.md` / `gemini.md` for living docs that are not pure changelog.
