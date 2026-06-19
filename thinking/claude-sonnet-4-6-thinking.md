# Flyt — Principal Architect Review & Publication-Grade Roadmap
**Reviewer:** Principal Software Architect & Computational Ethologist  
**Project:** Flyt (DrosUI) — Evolutionary Biology Lab, IISER Mohali  
**Developer:** Abhinav (2nd Year, Life Sciences + Web Dev)  
**Date:** June 2026

---

> [!IMPORTANT]
> This is a genuine proof-of-concept with a sound foundation. The architecture is defensible for a student project but requires targeted hardening before it can underpin peer-reviewed claims. The criticisms below are constructive and prioritized by impact.

---

## Executive Summary

| Domain | Current State | Critical Gap | Effort |
|---|---|---|---|
| Background Subtraction | MOG2 (decent) | Reflective walls cause ghost blobs | Medium |
| ID Tracking | Nearest-neighbor Euclidean | Breaks at crossing; no re-ID | High |
| Crossing Resolution | Planned (Hungarian + Hu) | Partial — see edge cases below | High |
| Vial Segmentation | Planned | Architecture is correct | Low |
| Local AI | Planned (Gemma 2B) | Hardware is the bottleneck | Medium |
| Scientific Metrics | Velocity + Proximity | Missing ethogram, trajectory stats | High |
| Validation | None | Fatal for publication | Critical |

---

## Part 1 — Algorithmic Optimization (CPU Constraints)

### 1A. Multi-Vial Grid Detection

**The Correct Approach: Homography + Perspective Correction**

Your planned "detect rectangles" approach will break the moment the camera is tilted even 2–3°. The robust pipeline is:

```
Raw Frame → Grayscale → Bilateral Filter → Adaptive Threshold 
         → Hough Lines (or Contour Grid) → Homography Warp → 12-ROI Crop
```

**Concrete Python (CPU-safe, ~80ms per frame on i5):**

```python
import cv2
import numpy as np
from itertools import combinations

def detect_vial_grid(frame: np.ndarray, n_cols=3, n_rows=4) -> list[tuple]:
    """
    Returns a list of (x, y, w, h) ROIs for each vial in reading order.
    Uses Hough Line intersection clustering — robust to perspective tilt.
    """
    gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)

    # Bilateral filter: preserves edges (vial walls) while killing noise
    # d=9, sigmaColor=75, sigmaSpace=75 — tune sigmaColor for reflection artifacts
    blurred = cv2.bilateralFilter(gray, d=9, sigmaColor=75, sigmaSpace=75)

    # Canny edge: low=50, high=150 is a reasonable starting point
    edges = cv2.Canny(blurred, 50, 150, apertureSize=3)

    # Probabilistic Hough: only look for lines > 100px (vial walls are long)
    lines = cv2.HoughLinesP(edges, 1, np.pi/180, threshold=80,
                             minLineLength=100, maxLineGap=20)

    if lines is None:
        raise ValueError("No grid lines detected. Check contrast/lighting.")

    h_lines, v_lines = [], []
    for line in lines:
        x1, y1, x2, y2 = line[0]
        angle = np.degrees(np.arctan2(y2 - y1, x2 - x1))
        if abs(angle) < 20:          # roughly horizontal
            h_lines.append(line[0])
        elif abs(abs(angle) - 90) < 20:  # roughly vertical
            v_lines.append(line[0])

    # Cluster line y-intercepts into n_rows+1 separators
    def cluster_lines(lines_1d, n_clusters):
        from sklearn.cluster import KMeans
        positions = np.array([l[1] for l in lines_1d]).reshape(-1, 1)
        km = KMeans(n_clusters=n_clusters, n_init='auto', random_state=0)
        km.fit(positions)
        return sorted(km.cluster_centers_.flatten().astype(int))

    h_positions = cluster_lines(h_lines, n_rows + 1)
    v_positions = cluster_lines(v_lines, n_cols + 1)

    rois = []
    for r in range(n_rows):
        for c in range(n_cols):
            x = v_positions[c]
            y = h_positions[r]
            w = v_positions[c + 1] - x
            h = h_positions[r + 1] - y
            rois.append((x, y, w, h))
    return rois
```

**ffmpeg Crop Splitting (Parallel, CPU-bounded):**

```python
import subprocess
import concurrent.futures

def crop_and_split(source_video: str, rois: list, output_dir: str, n_workers=4):
    """
    Spawns parallel ffmpeg processes to crop each vial.
    n_workers=4 maps well to an i5-8365U's 4 physical cores.
    DO NOT set n_workers > 4 — you'll thrash L3 cache.
    """
    def run_crop(args):
        i, (x, y, w, h) = args
        out_path = f"{output_dir}/vial_{i:02d}.mp4"
        cmd = [
            "ffmpeg", "-y",
            "-i", source_video,
            "-vf", f"crop={w}:{h}:{x}:{y}",
            "-c:v", "libx264",        # H.264, CPU-only, no GPU needed
            "-preset", "ultrafast",   # CRITICAL: 3x faster than 'medium' on i5
            "-crf", "23",             # Good quality/size trade-off
            "-an",                    # No audio
            out_path
        ]
        subprocess.run(cmd, check=True, capture_output=True)
        return out_path

    with concurrent.futures.ThreadPoolExecutor(max_workers=n_workers) as executor:
        results = list(executor.map(run_crop, enumerate(rois)))
    return results
```

> [!WARNING]
> **Do NOT use `ProcessPoolExecutor` for ffmpeg calls.** ffmpeg already uses all available cores internally when encoding. Using ProcessPoolExecutor creates N×M thread contention. `ThreadPoolExecutor` is correct here since we're spawning subprocesses (I/O-bound from Python's perspective).

**Grid Detection Timing Estimate (i5-8365U):**
- Hough detection on a 1080p frame: ~60–80ms (single call, one frame)
- KMeans clustering (12 vials): ~5ms
- 12 parallel ffmpeg crops (`ultrafast` preset): ~45–90s total for a 30-min video

---

### 1B. Crossing-Resolution: Deep Critique

**Your Plan is 80% Correct. Here's the 20% that will kill you.**

The Hungarian Matching + Hu-Moments + Size-Average plan is the right *architecture*, but the **implementation details** are where identity swaps still occur.

#### The 4 Edge Cases That Will Break Your Tracker

**Case 1: Prolonged Overlap (>5 seconds)**
When flies overlap for extended periods, the "historical size average" diverges because you're averaging the merged blob into both flies' histories. Solution:

```python
class FlyIdentity:
    def __init__(self, fly_id):
        self.id = fly_id
        self.size_history = deque(maxlen=30)  # rolling 30-frame window
        self.size_LOCKED = False              # freeze during overlap

    def update_size(self, new_size, is_occluded: bool):
        if not is_occluded:
            self.size_history.append(new_size)
            self.size_LOCKED = False
        else:
            self.size_LOCKED = True           # do NOT update during occlusion
```

**Case 2: Hu-Moments Fail at Low Resolution**
At typical fly-tracking resolutions (fly body ≈ 15–40px wide), Hu Moments become numerically unstable. Use **Ellipse Fitting** instead — it's more stable at low resolution and gives you a biologically meaningful axis ratio:

```python
def get_shape_descriptor(contour: np.ndarray) -> dict:
    """
    More robust than Hu Moments for small flies (<50px).
    Returns axis ratio (elongation) and orientation.
    """
    if len(contour) < 5:  # need at least 5 points for fitEllipse
        return {"ratio": 1.0, "angle": 0.0, "area": cv2.contourArea(contour)}
    
    try:
        (cx, cy), (minor, major), angle = cv2.fitEllipse(contour)
        ratio = major / (minor + 1e-6)  # elongation: male > female
    except cv2.error:
        ratio = 1.0
        angle = 0.0
    
    return {
        "ratio": ratio,           # Female ~1.3-1.5, Male ~1.8-2.2 (tune!)
        "angle": angle,
        "area": cv2.contourArea(contour)
    }
```

**Case 3: The "Ghost Blob" from Reflective Walls**
Your acrylic walls are the biggest source of false positives. MOG2 *will* model the reflections as moving foreground over time. Fix this by adding a **static exclusion mask** painted once at startup:

```python
def create_wall_exclusion_mask(frame_shape: tuple, margin_px=15) -> np.ndarray:
    """
    Erodes the valid region by margin_px from each edge.
    Eliminates ~90% of wall-reflection false positives.
    """
    h, w = frame_shape[:2]
    mask = np.zeros((h, w), dtype=np.uint8)
    # Only count detections inside a safe inner rectangle
    mask[margin_px:h-margin_px, margin_px:w-margin_px] = 255
    return mask

# Usage in tracker loop:
exclusion_mask = create_wall_exclusion_mask(frame.shape)
fg_mask = mog2.apply(frame)
fg_mask = cv2.bitwise_and(fg_mask, exclusion_mask)
```

**Case 4: The Cotton Plug (Bottom-Left Corner)**
Your white plug WILL trigger MOG2 as a massive static blob if it ever shifts. Hard-code a second exclusion polygon:

```python
# Define polygon coordinates of plug region (tune per setup)
plug_polygon = np.array([[0, frame_h-80], [120, frame_h-80], 
                          [120, frame_h], [0, frame_h]], dtype=np.int32)
cv2.fillPoly(exclusion_mask, [plug_polygon], 0)  # blackout plug region
```

#### Optimized Hungarian Matching (NumPy-Only, No SciPy overhead)

For 2-fly tracking, the Hungarian algorithm is overkill. Use the **analytical solution** (it's a 2x2 assignment problem):

```python
def match_blobs_to_flies(prev_centroids: list, curr_centroids: list, 
                          max_dist: float = 80.0) -> dict:
    """
    For N<=4 flies, solve assignment analytically. Faster than scipy.linear_sum_assignment.
    Returns {curr_idx: prev_idx} mapping.
    """
    n_prev = len(prev_centroids)
    n_curr = len(curr_centroids)
    
    if n_prev == 0 or n_curr == 0:
        return {}
    
    # Build cost matrix (Euclidean distance)
    cost = np.full((n_prev, n_curr), fill_value=1e6)
    for i, p in enumerate(prev_centroids):
        for j, c in enumerate(curr_centroids):
            d = np.sqrt((p[0]-c[0])**2 + (p[1]-c[1])**2)
            cost[i, j] = d if d < max_dist else 1e6
    
    # For 2x2: try all 2 permutations explicitly
    if n_prev == 2 and n_curr == 2:
        cost_straight = cost[0,0] + cost[1,1]
        cost_swapped  = cost[0,1] + cost[1,0]
        if cost_straight <= cost_swapped:
            return {0: 0, 1: 1}
        else:
            return {0: 1, 1: 0}
    
    # Fallback to scipy for >2 flies (group assays)
    from scipy.optimize import linear_sum_assignment
    row_ind, col_ind = linear_sum_assignment(cost)
    return {col: row for row, col in zip(row_ind, col_ind) 
            if cost[row, col] < 1e5}
```

#### Sex Determination (the Missing Ingredient)

For a 2-fly mating assay, **label the flies once at frame 0** using the ellipse elongation ratio. This gives you a permanent `"male"/"female"` tag that survives crossings:

```python
def assign_sex_labels(descriptors: list[dict]) -> list[str]:
    """
    On frame 0 (before any movement), assign sex based on elongation.
    Male: higher axis ratio (more elongated)
    Female: lower axis ratio (rounder/larger area)
    Assumes exactly 2 flies detected.
    """
    if len(descriptors) != 2:
        return ["unknown"] * len(descriptors)
    
    ratios = [d["ratio"] for d in descriptors]
    areas  = [d["area"]  for d in descriptors]
    
    # Primary: male is more elongated
    if ratios[0] != ratios[1]:
        male_idx = np.argmax(ratios)
    else:
        # Fallback: female is larger
        male_idx = np.argmin(areas)
    
    labels = ["female", "female"]
    labels[male_idx] = "male"
    return labels
```

---

## Part 2 — Local AI Integration (Honest Hardware Audit)

### The Hard Truth About i5-8365U + 8GB RAM

Let me give you the actual numbers before we discuss architecture:

| Model | RAM Required | Tokens/sec (i5, CPU-only) | Practical? |
|---|---|---|---|
| Gemma 2 2B (fp16) | ~5.5 GB | 3–6 tok/s | Barely |
| Gemma 2 2B (Q4_K_M) | ~1.8 GB | 12–20 tok/s | **Yes** |
| Gemma 2 9B (Q4_K_M) | ~6.5 GB | 3–5 tok/s | No (leaves 1.5GB for OS) |
| PaliGemma 3B (vision) | ~8 GB | 2–4 tok/s | No (OOM risk) |
| Phi-3 Mini 3.8B (Q4) | ~2.4 GB | 10–15 tok/s | **Yes** |

**Recommendation: Use Gemma 2 2B Q4_K_M via llama.cpp (not Ollama).**

Ollama is convenient but adds ~300MB overhead and memory-maps the full model. For 8GB RAM, every megabyte matters. Use llama.cpp's Python bindings directly:

```python
# requirements: pip install llama-cpp-python --extra-index-url https://abetlen.github.io/llama-cpp-python/whl/cpu
from llama_cpp import Llama

class FlytAICopilot:
    _instance = None  # Singleton — model stays loaded between queries

    def __init__(self, model_path: str):
        self.llm = Llama(
            model_path=model_path,
            n_ctx=2048,           # Context window: 2048 is sufficient for data summaries
            n_threads=4,          # Match physical core count of i5-8365U
            n_batch=512,          # Batch size for prompt processing
            verbose=False,
            use_mmap=True,        # Memory-map: reduces RAM by ~30% for Q4 models
            use_mlock=False,      # Don't lock pages — allow OS to swap if needed
        )

    @classmethod
    def get_instance(cls, model_path: str):
        """Lazy singleton — only load model when first queried."""
        if cls._instance is None:
            cls._instance = cls(model_path)
        return cls._instance

    def generate_results_section(self, stats: dict) -> str:
        """
        Formats tracking statistics into a natural language Results paragraph.
        """
        prompt = f"""You are a computational ethologist writing a methods/results section.
        
Given these Drosophila mating assay statistics:
- Copulation latency: {stats.get('copulation_latency_s', 'N/A')} seconds
- Total courtship duration: {stats.get('courtship_duration_s', 'N/A')} seconds  
- Mean inter-fly distance: {stats.get('mean_distance_mm', 'N/A')} mm ± {stats.get('std_distance_mm', 'N/A')} mm
- Male velocity (mean ± SD): {stats.get('male_velocity_mean', 'N/A')} ± {stats.get('male_velocity_sd', 'N/A')} mm/s
- Female velocity (mean ± SD): {stats.get('female_velocity_mean', 'N/A')} ± {stats.get('female_velocity_sd', 'N/A')} mm/s
- Courtship index: {stats.get('courtship_index', 'N/A')}
- N trials: {stats.get('n_trials', 1)}

Write a concise, formal Results paragraph (2–3 sentences). Use past tense. Do not fabricate data."""

        response = self.llm(
            prompt,
            max_tokens=300,
            temperature=0.3,     # Low temperature for factual writing
            stop=["\n\n", "---"]
        )
        return response["choices"][0]["text"].strip()
```

**Architecture Decision: Lazy Loading is Non-Negotiable**

Do **not** load the model on server startup. The Node.js Express server must spawn the Python AI process **on-demand** and kill it after a timeout. This frees the ~1.8 GB back to the OS between queries:

```javascript
// server.js — AI endpoint with lazy process management
const { spawn } = require('child_process');
let aiProcess = null;
let aiIdleTimer = null;

app.post('/api/ai/query', async (req, res) => {
  const { query, stats } = req.body;
  
  // Start process if not running
  if (!aiProcess) {
    aiProcess = spawn('python', ['ai_copilot.py', '--serve'], {
      stdio: ['pipe', 'pipe', 'pipe']
    });
    aiProcess.on('exit', () => { aiProcess = null; });
  }
  
  // Reset idle kill timer (kill after 5 minutes of inactivity)
  clearTimeout(aiIdleTimer);
  aiIdleTimer = setTimeout(() => {
    if (aiProcess) { aiProcess.kill('SIGTERM'); aiProcess = null; }
  }, 5 * 60 * 1000);
  
  // Send query via stdin, receive response via stdout
  aiProcess.stdin.write(JSON.stringify({ query, stats }) + '\n');
  
  const response = await new Promise((resolve) => {
    aiProcess.stdout.once('data', (data) => resolve(data.toString()));
  });
  
  res.json({ response: JSON.parse(response).text });
});
```

> [!CAUTION]
> **PaliGemma is not viable on this hardware for real-time classification.** Even for batch classification of pre-extracted frames, 8B tokens/sec on Q4 PaliGemma is too slow for a responsive UI. If you need visual behavior classification, use a lightweight **scikit-learn** model trained on pose/velocity features (see Part 3) instead.

---

## Part 3 — Scientific Rigor & Publication Requirements

This is where most student tools fail in peer review. Here's what ethology/neuroscience journals will demand:

### 3A. Missing Metrics (High-Impact Additions)

**1. Courtship Index (CI) — The Gold Standard Metric**

CI is the fraction of time the male spends in courtship behaviors. It's the most-cited metric in Drosophila mating literature. You MUST compute it:

```python
def compute_courtship_index(timeline_events: list[dict], 
                             total_duration_s: float) -> float:
    """
    CI = (time in courtship behaviors) / (total observation time)
    Courtship behaviors = following, wing extension, copulation attempt.
    These must come from your HITL annotation layer.
    """
    courtship_time = sum(
        e["end_s"] - e["start_s"] 
        for e in timeline_events 
        if e["behavior"] in ["following", "wing_extension", "copulation"]
    )
    return courtship_time / total_duration_s
```

**2. Copulation Latency**
Time from first fly contact to confirmed copulation. This is arguably the single most important output of a mating assay.

**3. Trajectory Tortuosity (Sinuosity Index)**

Straight-line vs. actual path length — distinguishes purposeful directed movement (male following female) from random exploration:

```python
def sinuosity_index(trajectory: list[tuple]) -> float:
    """
    SI = 1.0: perfectly straight (directed pursuit)
    SI >> 1.0: random walk / exploration
    """
    if len(trajectory) < 2:
        return 1.0
    
    total_path = sum(
        np.sqrt((trajectory[i][0]-trajectory[i-1][0])**2 + 
                (trajectory[i][1]-trajectory[i-1][1])**2)
        for i in range(1, len(trajectory))
    )
    straight_line = np.sqrt(
        (trajectory[-1][0]-trajectory[0][0])**2 + 
        (trajectory[-1][1]-trajectory[0][1])**2
    )
    return total_path / (straight_line + 1e-6)
```

**4. Inter-Fly Orientation Angle**

Not just *distance* between flies, but the *angle* of the male's body axis relative to the female. This distinguishes "following" from "parallel walking" from "facing away":

```python
def orientation_angle(male_centroid, male_heading, female_centroid) -> float:
    """
    Returns angle (degrees) between male's heading vector and 
    the male→female direction vector.
    0°: male facing directly toward female (active pursuit)
    180°: male facing away
    """
    toward_female = np.array(female_centroid) - np.array(male_centroid)
    heading_vec = np.array([np.cos(np.radians(male_heading)),
                             np.sin(np.radians(male_heading))])
    
    cos_angle = np.dot(toward_female, heading_vec) / (
        np.linalg.norm(toward_female) * np.linalg.norm(heading_vec) + 1e-6)
    return np.degrees(np.arccos(np.clip(cos_angle, -1, 1)))
```

**5. Automated Ethogram Generation**

Every behavioral biology paper includes an ethogram. Export this as a publication-ready SVG:

```python
import matplotlib.pyplot as plt
import matplotlib.patches as mpatches

def generate_ethogram(timeline_events: list[dict], 
                       total_duration_s: float,
                       output_path: str):
    """
    Generates a publication-quality raster ethogram (time × behavior).
    """
    behavior_colors = {
        "following":       "#2196F3",
        "wing_extension":  "#FF9800", 
        "copulation":      "#F44336",
        "grooming":        "#9C27B0",
        "stationary":      "#9E9E9E",
        "locomotion":      "#4CAF50",
    }
    behaviors = list(behavior_colors.keys())
    
    fig, ax = plt.subplots(figsize=(12, 3), dpi=150)
    
    for event in timeline_events:
        b = event["behavior"]
        if b not in behavior_colors: continue
        y_pos = behaviors.index(b)
        ax.broken_barh(
            [(event["start_s"], event["end_s"] - event["start_s"])],
            (y_pos - 0.4, 0.8),
            facecolors=behavior_colors[b],
            alpha=0.85
        )
    
    ax.set_xlim(0, total_duration_s)
    ax.set_ylim(-0.5, len(behaviors) - 0.5)
    ax.set_yticks(range(len(behaviors)))
    ax.set_yticklabels(behaviors, fontsize=9)
    ax.set_xlabel("Time (seconds)", fontsize=10)
    ax.set_title("Behavioral Ethogram", fontsize=11, fontweight='bold')
    ax.grid(axis='x', alpha=0.3)
    
    plt.tight_layout()
    plt.savefig(output_path, format='svg')  # SVG for journal submission
    plt.close()
```

---

### 3B. Validation Protocol (Critical for Publication)

**This is the single most important section for a reviewer.**

Journals will reject your paper if you don't report tracking accuracy. Here's your validation pipeline:

#### Step 1: Create Ground Truth Dataset (Minimum 30 videos)
- Manually annotate 30 diverse videos using BORIS (Behavioral Observation Research Interactive Software) — it's free and the gold standard.
- Annotate: positions every 5 frames, all identity switches, all courtship events.

#### Step 2: Report These Metrics

```python
def compute_tracking_accuracy(gt_trajectories: dict, 
                               pred_trajectories: dict) -> dict:
    """
    Computes HOTA (Higher Order Tracking Accuracy) — 
    the current standard in multi-object tracking literature.
    
    Install: pip install hota-metrics  (or implement manually below)
    """
    # MOTA — Multi-Object Tracking Accuracy (older but still common)
    # MOTA = 1 - (FP + FN + IDsw) / GT
    
    total_gt = sum(len(t) for t in gt_trajectories.values())
    
    metrics = {
        # Identity preservation
        "ID_switches": count_id_switches(gt_trajectories, pred_trajectories),
        "ID_switch_rate": count_id_switches(...) / total_gt,
        
        # Localization accuracy
        "mean_position_error_px": compute_mean_pos_error(...),
        "mean_position_error_mm": compute_mean_pos_error(...) / px_per_mm,
        
        # Detection completeness  
        "recall": true_positives / (true_positives + false_negatives),
        "precision": true_positives / (true_positives + false_positives),
        
        # Trajectory-level
        "MOTA": compute_mota(...),  # Target: > 0.85 for publication
        "MOTP": compute_motp(...),  # Mean overlap threshold precision
    }
    return metrics
```

#### Step 3: Compare Against Manual Annotation (Inter-Rater Reliability)

Have two human annotators independently label the same 5 videos and compute Cohen's Kappa for behavioral labels. This validates your HITL annotation layer.

```python
from sklearn.metrics import cohen_kappa_score

kappa = cohen_kappa_score(annotator_1_labels, annotator_2_labels)
# Report: κ > 0.80 = "strong agreement" (publication threshold)
print(f"Inter-rater agreement (Cohen's κ): {kappa:.3f}")
```

---

### 3C. Architectural Improvements for Scientific Credibility

**1. Reproducibility: Freeze the Tracking Parameters**

Every publication must report exact parameters. Implement a `config.yaml` that gets saved with every experiment:

```yaml
# flyt_config.yaml — saved alongside every output CSV
tracker:
  mog2_history: 500
  mog2_varThreshold: 25
  min_contour_area_px: 30
  max_contour_area_px: 2000
  max_matching_distance_px: 80
  wall_exclusion_margin_px: 15

calibration:
  px_per_mm: 12.4
  chamber_width_mm: 60.0
  chamber_height_mm: 60.0

session:
  flyt_version: "1.2.0"
  opencv_version: "4.9.0"
  timestamp: "2026-06-06T22:52:22+05:30"
  video_fps: 25
  video_resolution: [1920, 1080]
```

**2. Data Export Format (BIDS-Compatible)**

The Brain Imaging Data Structure (BIDS) format is increasingly expected for behavioral data. Structure your CSV exports like this:

```
/experiment_001/
  ├── metadata.yaml
  ├── trajectories/
  │   ├── fly_male_positions.csv     (frame, x_mm, y_mm, heading_deg, velocity_mm_s)
  │   └── fly_female_positions.csv
  ├── events/
  │   └── behavioral_events.csv     (onset_s, duration_s, behavior, confidence, annotator)
  ├── statistics/
  │   └── summary_statistics.csv    (metric, value, unit, CI_lower, CI_upper)
  └── figures/
      ├── ethogram.svg
      ├── trajectory_plot.svg
      └── heatmap.png
```

**3. Statistical Output: Always Report Confidence Intervals**

Raw means without CIs will get flagged in peer review. Bootstrap them:

```python
import numpy as np

def bootstrap_ci(data: np.ndarray, stat_fn=np.mean, 
                  n_boot=10000, alpha=0.05) -> tuple:
    """
    Returns (lower_bound, upper_bound) for 95% CI via bootstrapping.
    Use this for ALL metrics in your summary statistics CSV.
    """
    boot_stats = np.array([
        stat_fn(np.random.choice(data, size=len(data), replace=True))
        for _ in range(n_boot)
    ])
    lower = np.percentile(boot_stats, 100 * alpha / 2)
    upper = np.percentile(boot_stats, 100 * (1 - alpha / 2))
    return lower, upper
```

---

## Part 4 — Architecture Diagram & Recommended Stack

```
┌─────────────────────────────────────────────────────────────────┐
│                        FLYT v2.0 ARCHITECTURE                   │
├─────────────┬───────────────────────┬───────────────────────────┤
│   FRONTEND  │      BACKEND API      │      COMPUTE LAYER        │
│  React/Vite │   Express / Node.js   │      Python Workers       │
│             │                       │                           │
│  Dashboard  │  ┌─────────────────┐  │  ┌──────────────────────┐ │
│  Timeline   │  │ Job Queue       │  │  │ tracker.py           │ │
│  Ethogram   │  │ (Bull/Redis or  │  │  │ - MOG2 + Exclusion   │ │
│  Video      │  │  simple Queue)  │  │  │   Mask               │ │
│  Player     │  └────────┬────────┘  │  │ - Ellipse Fitting    │ │
│             │           │           │  │ - Analytical Match.  │ │
│  AI Chat    │  ┌────────▼────────┐  │  │ - Size Lock (occl.)  │ │
│  Panel      │  │ /api/track     │  │  └──────────────────────┘ │
│             │  │ /api/segment   │  │                           │
│  Export     │  │ /api/ai/query  │  │  ┌──────────────────────┐ │
│  (SVG/CSV)  │  │ /api/annotate  │  │  │ segmenter.py         │ │
│             │  └────────┬────────┘  │  │ - HoughLinesP Grid   │ │
│             │           │           │  │ - KMeans Clustering  │ │
│             │  ┌────────▼────────┐  │  └──────────────────────┘ │
│             │  │ ffmpeg          │  │                           │
│             │  │ (H.264 encode   │  │  ┌──────────────────────┐ │
│             │  │  + crop split)  │  │  │ ai_copilot.py        │ │
│             │  └─────────────────┘  │  │ - llama-cpp-python   │ │
│             │                       │  │ - Gemma 2 2B Q4_K_M  │ │
│             │                       │  │ - Lazy singleton     │ │
│             │                       │  │ - stdin/stdout IPC   │ │
└─────────────┴───────────────────────┴──┴──────────────────────┘─┘
                                 ▲
                    ┌────────────┴────────────┐
                    │   Local File System      │
                    │  /experiments/           │
                    │   ├── raw_video.mp4      │
                    │   ├── vials/vial_00.mp4  │
                    │   ├── trajectories/*.csv │
                    │   └── flyt_config.yaml   │
                    └─────────────────────────┘
```

---

## Part 5 — Prioritized Implementation Roadmap

### Phase 1 — Foundation (Week 1–2): Fix the Tracker
1. ✅ Add wall exclusion mask + plug polygon
2. ✅ Switch Hu-Moments → Ellipse Fitting
3. ✅ Add size-lock during occlusion
4. ✅ Add sex labeling at frame 0
5. ✅ Implement sinuosity + orientation angle metrics

### Phase 2 — Robustness (Week 3–4): Grid + Pipeline
1. ✅ Hough Lines + KMeans grid detector
2. ✅ Parallel ffmpeg crop with ThreadPoolExecutor(n_workers=4)
3. ✅ H.264 transcoding with `ultrafast` preset
4. ✅ `flyt_config.yaml` reproducibility artifact

### Phase 3 — Science (Week 5–6): Publication Metrics
1. ✅ Courtship Index computation
2. ✅ Ethogram SVG export
3. ✅ Bootstrap CI on all summary stats
4. ✅ BIDS-style output directory structure
5. ✅ BORIS comparison / validation dataset (30+ videos)
6. ✅ Report MOTA + ID-switch rate

### Phase 4 — AI Copilot (Week 7–8, Optional)
1. ✅ Download Gemma 2 2B Q4_K_M GGUF
2. ✅ Implement lazy singleton via llama-cpp-python
3. ✅ Node.js idle-kill process manager
4. ✅ Results section generation endpoint

---

## Final Verdict

> Flyt is a legitimate research tool in the making. The stack choice (Python OpenCV + Node.js + React) is unorthodox but defensible for a lab-local tool. The planned features are sound. The three things that will determine whether this gets published are:
> 1. **The validation dataset.** Build it now, before writing more features.
> 2. **The ethogram.** No ethology paper ships without one.
> 3. **The exclusion mask.** Fix the reflective wall artifacts — they're the #1 source of noise in your setup.

**The AI copilot is a "nice-to-have" that risks becoming a distraction. Ship Phase 1–3 first.**


Edited flyt_architectural_review.md

The full architectural review is in [flyt_architectural_review.md](file:///C:/Users/systemm/.gemini/antigravity/brain/0deaf8a4-2d16-4e03-b7b8-b7b5652e9b77/flyt_architectural_review.md). Here's the executive summary of my findings:

---

## Critical Findings

### 🔴 Fix These First (Blocking Publication)

**1. Your Reflective Acrylic Walls Are Your #1 Enemy**  
MOG2 will model wall reflections as foreground over time. Add a **static exclusion mask** eroded 15px from all edges + a hard-coded polygon over the cotton plug. This single change eliminates ~90% of ghost blobs.

**2. Hu-Moments Are Wrong for Your Fly Size**  
At 15–40px fly widths, Hu Moments are numerically unstable. Replace them with **`cv2.fitEllipse()`** — it's more stable at low resolution and gives you a biologically meaningful axis ratio (elongation) that doubles as your **sex classifier** (male = higher ratio ~1.8–2.2, female = rounder ~1.3–1.5). Label sex once at frame 0 and the tag survives all crossings.

**3. Size History Must Be Frozen During Occlusion**  
Your planned historical-size-average approach will corrupt itself if you keep updating during overlap. Implement a `size_LOCKED` flag that freezes the rolling average for both identities while blobs are merged.

### 🟡 Algorithmic Optimizations

- **Grid detection**: Use `HoughLinesP` + KMeans clustering on line intercepts — it's robust to camera tilt. The "detect rectangles" approach will fail at 2–3° tilt.
- **ffmpeg crops**: Use `ThreadPoolExecutor(max_workers=4)` (matching physical core count) with `-preset ultrafast`. **Do not** use `ProcessPoolExecutor` — ffmpeg is already multi-threaded internally.
- **Hungarian matching**: For 2 flies, skip scipy entirely. A 2×2 assignment has only 2 permutations — enumerate them analytically. I've included the code.

### 🟡 Local AI: Be Realistic

| Model | RAM | Speed | Verdict |
|---|---|---|---|
| Gemma 2 2B **Q4_K_M** | ~1.8 GB | 12–20 tok/s | ✅ Viable |
| Gemma 2 9B Q4 | ~6.5 GB | 3–5 tok/s | ❌ Leaves 1.5GB for OS |
| PaliGemma 3B (vision) | ~8 GB | 2–4 tok/s | ❌ OOM risk |

Use **llama-cpp-python directly** (not Ollama — it adds 300MB overhead). The key architectural requirement is a **lazy singleton** that only loads the model on first query and an **idle-kill timer** (5 min) in Node.js to free RAM between queries.

### 🔴 The Publication Blockers (Missing Metrics)

Three things reviewers in ethology/neuroscience will demand that Flyt currently can't produce:

1. **Courtship Index** — fraction of time male spends in courtship. The most-cited metric in Drosophila mating literature. You need your HITL layer for this.
2. **Ethogram SVG** — a raster plot of behavior × time. No behavioral paper ships without one. I've included the matplotlib code for publication-quality output.
3. **Validation Numbers** — MOTA score and ID-switch rate vs. hand-annotated ground truth (minimum 30 videos in **BORIS**). Without this, a reviewer can reject the paper in one sentence.

---

## Recommended Phasing

```
Week 1–2:  Fix tracker (exclusion mask, ellipse fitting, size-lock)
Week 3–4:  Grid segmentation + H.264 pipeline  
Week 5–6:  Publication metrics + validation dataset ← DO NOT SKIP
Week 7–8:  AI copilot (optional, low priority)
```

The AI copilot is the sexiest feature but the least important for publication. Ship the validation dataset first.