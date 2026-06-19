# Flyt Colab CLI Sandbox — Standard Operating Procedure

> **Status:** Canonical SOP (merged from `grok-on-colabcli.md` + `gemini-on-colabcli.md`)  
> **Date:** 2026-06-15  
> **Rule:** Colab = experiment garage. Local CPU = production + gatekeeper.

---

## Objective

Rapidly iterate on OpenCV MOG2 tracking experiments on a remote T4 Colab instance without making GPU/cloud a production dependency. Every Colab artifact must pass local A/B diff against `E:\prasad-pitch` before any merge into `tracker.py`.

---

## Hard rules (non-negotiable)

1. **Never edit** `E:\prasad-pitch` (read-only gold reference).
2. **Never** route production `tracker.py` or dashboard through Colab silently.
3. **Never** merge experimental logic without automated CSV diff + human review.
4. Use **`opencv-python-headless`** in Colab — same wheel family as local CPU. No `cv2.cuda` unless explicitly benchmarking CUDA (breaks parity).
5. Repo for experiments lives in **WSL native filesystem** (`~/projects/flyt-colab`), not `/mnt/e/...` (slow I/O).
6. Always **`colab stop -s <session>`** — ghost VMs burn credits.

---

## Prerequisites (one-time, WSL2 Ubuntu)

Native Windows PowerShell is **not officially supported** (fcntl, TTY). Use WSL2.

```bash
# WSL Ubuntu terminal
curl -LsSf https://astral.sh/uv/install.sh | sh
source ~/.bashrc
uv tool install git+https://github.com/googlecolab/google-colab-cli
colab version

# Auth — use ADC with colaboratory scope (avoids 5–6 min Keep-Alive OAuth failures)
gcloud auth application-default login \
  --scopes=openid,https://www.googleapis.com/auth/cloud-platform,https://www.googleapis.com/auth/userinfo.email,https://www.googleapis.com/auth/colaboratory
```

**Official links:**
- CLI repo: https://github.com/googlecolab/google-colab-cli
- Announcement: https://developers.googleblog.com/introducing-the-google-colab-cli/
- Colab FAQ: https://research.google.com/colaboratory/faq.html

---

## Directory layout

```
~/projects/
├── flyt-prod/          # symlink or git clone of E:\Flyt (WSL copy, fast path)
│   └── assets/fly_video.mp4
└── flyt-colab/         # sandbox only — never ships to production as-is
    ├── experiments/    # exp_K02_hungarian.py, etc.
    ├── results/        # downloaded CSVs, .ipynb logs
    ├── manifests/      # JSON per run (params, hashes)
    └── scripts/
        ├── hello_cv.py
        ├── baseline_repro.py
        └── csv_validator.py
```

Sync Windows ↔ WSL: `cp` or `rsync` test videos into `~/projects/flyt-colab/assets/`. Do **not** use `colab drivemount` in automated scripts (breaks headless/agent flows).

---

## Quick Start (first successful exec)

```bash
SESSION="flyt-quickstart"
VIDEO_LOCAL="assets/fly_video.mp4"   # short clip OK for first test
VIDEO_REMOTE="/content/fly.mp4"

colab new -s $SESSION --gpu T4
colab status -s $SESSION
colab upload -s $SESSION "$VIDEO_LOCAL" "$VIDEO_REMOTE"
colab install -s $SESSION opencv-python-headless numpy pandas

colab exec -s $SESSION -f scripts/hello_cv.py
# hello_cv.py: cv2.VideoCapture("/content/fly.mp4"), read one frame, print shape

colab stop -s $SESSION
```

---

## Standard experiment loop

```bash
SESSION="exp_K02_v1"
colab new --gpu T4 -s $SESSION
colab install -s $SESSION opencv-python-headless numpy pandas scipy   # scipy = experiments only

colab upload -s $SESSION ./assets/fly_video.mp4 /content/fly_video.mp4
colab exec -s $SESSION -f ./experiments/exp_script.py

colab download -s $SESSION /content/output.csv ./results/${SESSION}_output.csv
colab log -s $SESSION -o ./results/${SESSION}_history.ipynb
colab stop -s $SESSION

# Gate on local machine (cool PC)
python scripts/csv_validator.py \
  --candidate ./results/${SESSION}_output.csv \
  --gold ../flyt-prod/../prasad-pitch-output/gold.csv
```

### Script requirements

- Read input from `/content/...`
- Write CSV to `/content/output.csv`
- **Heartbeat:** `print(f"Processed frame {idx}", flush=True)` every ≤25s (CLI keep-alive / long-run stability)
- Emit `manifests/${SESSION}.json` locally before upload (video SHA256, git commit, hyperparameters)

### Manifest template

```json
{
  "experiment_id": "exp_K02_id_swap_v1",
  "timestamp": "2026-06-15T15:00:00Z",
  "git_commit_hash": "<short-sha>",
  "video_asset_hash_sha256": "<sha256>",
  "hyperparameters": {
    "mog2_history": 500,
    "mog2_varThreshold": 50,
    "contour_min_area": 30,
    "proximity_threshold": 60
  },
  "hardware_profile": "Colab T4 (CPU execution, opencv-python-headless)"
}
```

### Diff gate (before any merge)

Compare against pitch gold on core columns:

`frame`, `fly1_x`, `fly1_y`, `fly2_x`, `fly2_y`, `proximity_distance`

- **Parity run:** expect **0 diffs** on `fly_video.mp4` when porting pitch faithfully
- **Improvement run:** document intentional deltas; require human frame review on occlusion/ID-swap clips — not just RMSE

---

## Does T4 actually help MOG2?

**Honest answer:** Standard `opencv-python-headless` MOG2 is **CPU-bound**. T4 GPU is idle unless you compile OpenCV+CUDA (hours of setup, breaks production parity).

**Real Colab value for Flyt:**

| Benefit | Why |
|---------|-----|
| Thermal offload | Your i5 stays cool; dev continues locally |
| Faster Colab CPU | Xeon-class host often beats throttled laptop |
| Parameter grids | Sweep MOG2/assignment params on many clips |
| Long batch runs | No local fan/throttle interruptions |
| Future optional DL | Same CLI if SLEAP/DLC experiments ever happen |

**Stay CPU-only in sandbox** to match production determinism.

---

## When to use Colab vs local

| Use **Colab** | Use **local venv** |
|---------------|-------------------|
| Parameter sweeps, batch videos | Quick edits, dashboard, server |
| K-02/K-03 discovery scripts | Final gold A/B on full `fly_video.mp4` |
| Thermal offload on long runs | Sensitive raw assay footage (default stay local) |
| Prototyping scipy/Hungarian variants | Anything that ships in `tracker.py` |

---

## Prioritized experiments (consensus)

| Rank | Experiment | Why first |
|------|------------|-----------|
| **1** | **Baseline reproduction + parity** | Prove toolchain; 0-diff vs pitch on `fly_video.mp4` before any "improvement" |
| **2** | **K-02 / K-03** (ID swap, merge/occlusion) | Biggest practical blockers; tune on curated short clips + visual review |
| **3** | **K-08** (px→mm / px/sec) | Mostly local affine calibration; low Colab value |

**Avoid until human ground-truth scoring exists:** claiming DL superiority, complex stochastic trackers, silent production replacement, long uncheckpointed runs.

---

## Limits, cost, reliability

| Topic | Notes |
|-------|-------|
| Free tier | Sporadic T4; 24h max session; idle kill ~90 min without CLI keep-alive |
| Colab Pro | Compute Units; **must** `colab stop` — daemon prevents idle shutdown |
| Disconnects | Re-upload + rerun; save manifests; use `colab log` for replay notebook |
| Data security | Assay footage leaves machine on upload — use dedicated account, short clips, lab ethics approval |
| Ghost VMs | Run `colab sessions` and `colab stop -s <name>` after every experiment |

---

## Anti-patterns (academic lab)

- **Silent cloud replacement** — prod tracker must run air-gapped CPU
- **CUDA lock-in** — `cv2.cuda` code won't run on lab i5
- **Unverified artifacts** — always `colab download` + diff gate
- **Ghost VM** — Ctrl+C locally does not stop remote session
- **Missing manifests** — irreproducible science
- **Skipping human GT** on ID-swap/occlusion claims
- **Agent editing `tracker.py`** from Colab results without A/B proof

---

## Agent rules (this workspace)

Agents may:

- Write scripts under `flyt-colab/experiments/`
- Run `colab new` / `exec` / `download` / `stop` via WSL
- Produce diff reports vs pitch gold

Agents may **not**:

- Merge experimental code into production `tracker.py` without user sign-off + 0-diff or documented human-validated improvement
- Add GPU/cloud as default production path
- Guess ethology thresholds (Deep Research Protocol still applies)

---

## Next steps

1. Run Quick Start in WSL (frame read succeeds)
2. Implement `baseline_repro.py` (minimal pitch port) + `csv_validator.py`
3. Experiment #1: parity on `fly_video.mp4` — target **0 diffs** on core columns
4. Only then: K-02/K-03 parameter sweeps on short contact clips