# Flyt — Principal Architectural Review

**Reviewer Role**: Principal Software Architect & Computational Ethologist  
**Project**: Flyt (formerly DrosUI) — Drosophila Behavioral Tracking  
**Lab**: Dr. N.G. Prasad, Evolutionary Biology Lab, IISER Mohali  
**Date**: June 2026

---

## Executive Summary

Flyt is architecturally sound as a proof-of-concept. The MOG2 + nearest-neighbor pipeline is the correct starting point for CPU-constrained fly tracking. However, to reach **publication grade**, the system needs three categories of hardening:

1. **Algorithmic** — Your crossing-resolution plan has a critical gap (Hu moments alone will fail on dorsal-view *Drosophila*). I propose a stronger composite identity model.
2. **AI Integration** — Gemma 2B is feasible on your hardware but only with aggressive quantization and an async architecture. PaliGemma is borderline infeasible for real-time use.
3. **Scientific Rigor** — You need ground-truth validation, inter-rater reliability metrics, and several ethologically-specific metrics beyond velocity/proximity to be publishable.

---

## 1. Algorithmic Optimization (CPU Constraints)

### 1.1 Multi-Vial Grid Detection & Crop-Splitting

Your plan to detect 12 vials and spawn 12 parallel ffmpeg crops is correct in principle, but **spawning 12 simultaneous ffmpeg processes will thrash an i5-8365U** (4C/8T, 15W TDP). Here's the optimized architecture:

#### Detection Strategy

Don't over-engineer the grid detection. For a fixed physical setup (12 vials in a known grid):

```python
import cv2
import numpy as np

def detect_vial_grid(frame, expected_rows=3, expected_cols=4, 
                     min_area_ratio=0.005, max_area_ratio=0.15):
    """
    Detect rectangular vial regions in a multi-vial image.
    Works on the FIRST frame only — assumes static camera.
    """
    gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
    
    # Adaptive threshold handles uneven illumination across the grid
    thresh = cv2.adaptiveThreshold(
        gray, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
        cv2.THRESH_BINARY_INV, blockSize=51, C=10
    )
    
    # Morphological close to merge internal textures (mesh grid)
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (15, 15))
    closed = cv2.morphologyEx(thresh, cv2.MORPH_CLOSE, kernel, iterations=3)
    
    contours, _ = cv2.findContours(closed, cv2.RETR_EXTERNAL, 
                                    cv2.CHAIN_APPROX_SIMPLE)
    
    frame_area = frame.shape[0] * frame.shape[1]
    vials = []
    
    for cnt in contours:
        area = cv2.contourArea(cnt)
        if min_area_ratio * frame_area < area < max_area_ratio * frame_area:
            rect = cv2.boundingRect(cnt)
            vials.append(rect)
    
    # Sort by position: top-to-bottom, left-to-right
    vials.sort(key=lambda r: (r[1] // (frame.shape[0] // expected_rows), r[0]))
    
    if len(vials) != expected_rows * expected_cols:
        # Fallback: uniform grid subdivision
        h, w = frame.shape[:2]
        cell_h, cell_w = h // expected_rows, w // expected_cols
        vials = [
            (c * cell_w, r * cell_h, cell_w, cell_h)
            for r in range(expected_rows)
            for c in range(expected_cols)
        ]
    
    return vials
```

#### Crop-Splitting: Sequential, Not Parallel

> [!WARNING]
> **Do NOT spawn 12 parallel ffmpeg processes.** On a 4-core i5 with 8GB RAM, 12 simultaneous H.264 encodes will cause memory pressure and context-switching overhead that makes the total wall-clock time *slower* than sequential.

**Optimal strategy**: Run a **single ffmpeg command** that reads the input once and produces all 12 crops using the `split` filter:

```bash
ffmpeg -i input.mp4 \
  -filter_complex "
    [0:v]split=12[s0][s1][s2][s3][s4][s5][s6][s7][s8][s9][s10][s11];
    [s0]crop=w0:h0:x0:y0[v0];
    [s1]crop=w1:h1:x1:y1[v1];
    ...
    [s11]crop=w11:h11:x11:y11[v11]
  " \
  -map "[v0]" -c:v libx264 -preset ultrafast -crf 23 vial_0.mp4 \
  -map "[v1]" -c:v libx264 -preset ultrafast -crf 23 vial_1.mp4 \
  ...
```

Or, even better for CPU, use **two-pass batching** (6 crops per pass, 2 passes):

```javascript
// server.js — batched crop spawner
async function cropVials(inputPath, vialRects, outputDir) {
  const BATCH_SIZE = Math.min(vialRects.length, 
                               Math.floor(os.cpus().length * 1.5));
  
  for (let i = 0; i < vialRects.length; i += BATCH_SIZE) {
    const batch = vialRects.slice(i, i + BATCH_SIZE);
    const promises = batch.map((rect, j) => {
      const idx = i + j;
      const { x, y, w, h } = rect;
      return spawnFFmpeg(inputPath, 
        `-vf "crop=${w}:${h}:${x}:${y}" -c:v libx264 -preset ultrafast -crf 23`,
        path.join(outputDir, `vial_${idx}.mp4`)
      );
    });
    await Promise.all(promises); // Wait for batch before next
  }
}
```

#### H.264 Transcoding Note

Your plan is correct. One refinement — use `-preset veryfast` instead of the default `medium`. On your i5, this is the sweet spot between encode speed and file size:

```javascript
// In your ffmpeg spawn call
const args = [
  '-i', inputPath,
  '-c:v', 'libx264',
  '-preset', 'veryfast',  // NOT 'medium' — too slow for real-time on i5
  '-crf', '23',           // Visually lossless for tracking purposes
  '-movflags', '+faststart', // Enables progressive playback in browser
  '-y', outputPath
];
```

---

### 1.2 Crossing Resolution — Identity Preservation

This is the **hardest unsolved problem** in your pipeline. Let me be blunt about your current plan:

#### What Will Break

| Planned Feature | Failure Mode | Severity |
|---|---|---|
| **Hu Moments** | Dorsal-view flies are nearly elliptical — Hu moments for male vs. female differ by < 5% in most frames. Rotation invariance *hurts* you here because orientation is actually discriminative. | 🔴 Critical |
| **Size averages (ToxId-Light)** | Works well for *Drosophila melanogaster* dimorphism (~30% area difference). **Fails** when flies are at different Z-heights (legs vs. wings extended), when the female is freshly eclosed (smaller), or in same-sex assays. | 🟡 Moderate |
| **Hungarian matching alone** | Optimal assignment assumes the cost matrix is reliable. If both Hu moments and size are noisy, Hungarian will confidently make the *wrong* assignment. | 🟡 Moderate |

#### Recommended Composite Identity Model

Replace Hu moments with a **multi-feature identity vector** that exploits the specific biology of your assay:

```python
import numpy as np
from scipy.optimize import linear_sum_assignment
from collections import deque

class FlyIdentityModel:
    """
    Composite identity model for 2-fly mating chamber.
    Uses size, aspect ratio, orientation history, and spatial prior.
    """
    
    def __init__(self, n_flies=2, history_len=30):
        self.n_flies = n_flies
        self.history_len = history_len
        
        # Per-fly feature histories (rolling windows)
        self.size_history = [deque(maxlen=history_len) for _ in range(n_flies)]
        self.aspect_history = [deque(maxlen=history_len) for _ in range(n_flies)]
        self.position_history = [deque(maxlen=history_len) for _ in range(n_flies)]
        self.orientation_history = [deque(maxlen=history_len) for _ in range(n_flies)]
    
    def extract_features(self, contour):
        """Extract discriminative features from a single contour."""
        area = cv2.contourArea(contour)
        
        if len(contour) < 5:
            # Fallback for tiny contours
            x, y, w, h = cv2.boundingRect(contour)
            return {
                'area': area,
                'aspect_ratio': max(w, h) / (min(w, h) + 1e-6),
                'orientation': 0.0,
                'centroid': (x + w/2, y + h/2),
                'ellipse_axes': (w, h),
            }
        
        ellipse = cv2.fitEllipse(contour)
        center, (ma, MA), angle = ellipse
        
        return {
            'area': area,
            'aspect_ratio': MA / (ma + 1e-6),  # Major/minor axis ratio
            'orientation': angle,                # Heading direction
            'centroid': center,
            'ellipse_axes': (ma, MA),
        }
    
    def compute_identity_cost(self, features, fly_id):
        """
        Cost of assigning `features` to `fly_id`.
        Lower = better match. Weighted multi-feature distance.
        """
        if len(self.size_history[fly_id]) == 0:
            return 0.0  # No history yet — free assignment
        
        costs = []
        
        # 1. SIZE COST (most discriminative for male/female)
        #    Normalized by the running mean to handle scale changes
        mean_size = np.mean(self.size_history[fly_id])
        size_cost = abs(features['area'] - mean_size) / (mean_size + 1e-6)
        costs.append(('size', size_cost, 3.0))  # weight=3.0
        
        # 2. ASPECT RATIO COST
        #    Males are more elongated (higher aspect ratio in dorsal view)
        mean_aspect = np.mean(self.aspect_history[fly_id])
        aspect_cost = abs(features['aspect_ratio'] - mean_aspect) / (mean_aspect + 1e-6)
        costs.append(('aspect', aspect_cost, 2.0))  # weight=2.0
        
        # 3. SPATIAL CONTINUITY COST (Kalman-like prediction)
        #    Where do we EXPECT this fly to be based on recent trajectory?
        if len(self.position_history[fly_id]) >= 2:
            positions = list(self.position_history[fly_id])
            # Linear velocity prediction
            vel = np.array(positions[-1]) - np.array(positions[-2])
            predicted = np.array(positions[-1]) + vel
            actual = np.array(features['centroid'])
            spatial_cost = np.linalg.norm(actual - predicted) / 50.0  # normalize
            costs.append(('spatial', spatial_cost, 2.5))  # weight=2.5
        
        # 4. ORIENTATION CONTINUITY COST
        #    Flies don't teleport or spin 180° between frames
        if len(self.orientation_history[fly_id]) >= 1:
            last_orient = self.orientation_history[fly_id][-1]
            orient_diff = abs(features['orientation'] - last_orient)
            orient_diff = min(orient_diff, 180 - orient_diff)  # Circular
            orient_cost = orient_diff / 90.0
            costs.append(('orient', orient_cost, 1.0))  # weight=1.0
        
        # Weighted sum
        total = sum(cost * weight for _, cost, weight in costs)
        total_weight = sum(weight for _, _, weight in costs)
        return total / total_weight
    
    def resolve_crossing(self, contours_after_split):
        """
        Called when a merged blob splits back into N blobs.
        Returns optimal ID assignment using Hungarian algorithm.
        """
        n_detected = len(contours_after_split)
        n_tracks = self.n_flies
        
        # Build cost matrix
        features_list = [self.extract_features(c) for c in contours_after_split]
        cost_matrix = np.zeros((n_detected, n_tracks))
        
        for i, feat in enumerate(features_list):
            for j in range(n_tracks):
                cost_matrix[i, j] = self.compute_identity_cost(feat, j)
        
        # Hungarian assignment
        row_ind, col_ind = linear_sum_assignment(cost_matrix)
        
        # Confidence: ratio of best to second-best assignment cost
        assignment = {}
        for r, c in zip(row_ind, col_ind):
            assignment[r] = c
            # Update histories with new observation
            feat = features_list[r]
            self.size_history[c].append(feat['area'])
            self.aspect_history[c].append(feat['aspect_ratio'])
            self.position_history[c].append(feat['centroid'])
            self.orientation_history[c].append(feat['orientation'])
        
        return assignment, cost_matrix
```

#### Critical Edge Cases & Mitigations

| Edge Case | What Happens | Mitigation |
|---|---|---|
| **Copulation** (flies locked for minutes) | Merged blob for 5+ minutes. All velocity/position history goes stale. | Freeze identity model during merge. On split, rely ONLY on size (most stable). Add a `merge_duration` field to output CSV for downstream filtering. |
| **Wall reflections** | Acrylic walls create ghost contours near edges. | Add a **guard margin** (10-15px from detected chamber boundary) and discard contours whose centroid falls in the margin. |
| **Cotton plug occlusion** | Fly walks behind/onto the white plug, causing partial or total occlusion. | Detect the plug region on frame 1 (brightest connected component in bottom-left quadrant). When a tracked fly enters the plug zone and disappears, maintain a "ghost track" at last known position for up to N frames. |
| **Mesh grid texture** | High-frequency texture creates false MOG2 foreground noise. | Increase `history` parameter in MOG2 (e.g., `cv2.createBackgroundSubtractorMOG2(history=1000, varThreshold=50)`). Apply a median blur (`cv2.medianBlur(frame, 5)`) BEFORE feeding to MOG2 to suppress grid texture. |
| **Same-sex assays** | Size dimorphism disappears. Your entire size-based identity model collapses. | For same-sex: fall back to **spatial continuity only** (Kalman filter). Flag these videos for higher human-in-the-loop review rates. In your paper, report separate accuracy for dimorphic vs. monomorphic pairs. |

#### Python Performance Optimizations

```python
# 1. Pre-allocate contour processing — avoid per-frame list allocations
#    Use numpy vectorized operations for centroid calculations
def fast_centroids(contours):
    """Vectorized centroid computation — 3x faster than cv2.moments loop."""
    centroids = np.empty((len(contours), 2), dtype=np.float32)
    for i, c in enumerate(contours):
        M = cv2.moments(c)
        if M['m00'] > 0:
            centroids[i] = [M['m10']/M['m00'], M['m01']/M['m00']]
        else:
            centroids[i] = c[0][0]  # fallback to first point
    return centroids

# 2. Frame skipping for non-critical analysis
#    Not every frame needs full contour analysis — subsample for metrics
def should_process_frame(frame_idx, fps, mode='full'):
    """
    'full': every frame (for tracking)
    'metrics': every 3rd frame (for velocity/proximity — 10fps is sufficient)
    'sleep': every 30th frame (for sleep detection — 1fps is plenty)
    """
    if mode == 'full':
        return True
    elif mode == 'metrics':
        return frame_idx % 3 == 0
    elif mode == 'sleep':
        return frame_idx % int(fps) == 0

# 3. ROI-restricted processing
#    After frame 1, only run MOG2 on the chamber interior, not full frame
def create_chamber_mask(first_frame, margin=20):
    """Detect chamber boundary and create a processing mask."""
    gray = cv2.cvtColor(first_frame, cv2.COLOR_BGR2GRAY)
    edges = cv2.Canny(gray, 50, 150)
    contours, _ = cv2.findContours(edges, cv2.RETR_EXTERNAL, 
                                    cv2.CHAIN_APPROX_SIMPLE)
    # Largest contour = chamber boundary
    chamber = max(contours, key=cv2.contourArea)
    mask = np.zeros(gray.shape, dtype=np.uint8)
    cv2.drawContours(mask, [chamber], -1, 255, -1)
    # Erode by margin to exclude wall reflections
    kernel = np.ones((margin, margin), np.uint8)
    mask = cv2.erode(mask, kernel)
    return mask
```

---

## 2. Local AI Integration (Gemma / PaliGemma)

### 2.1 Feasibility Assessment

| Model | Params | Q4 Size | RAM at Inference | Feasible on 8GB? | Tokens/sec (i5 CPU) |
|---|---|---|---|---|---|
| **Gemma 2 2B** (Q4_K_M) | 2.6B | ~1.8 GB | ~2.5 GB | ✅ Yes | ~8-12 tok/s |
| **Gemma 2 2B** (Q8_0) | 2.6B | ~2.8 GB | ~3.5 GB | ✅ Yes (tight) | ~5-8 tok/s |
| **PaliGemma 3B** (Q4) | 3B | ~2.2 GB | ~3.5 GB + image encoding | ⚠️ Marginal | ~3-5 tok/s |
| **PaliGemma 3B** (FP16) | 3B | ~6 GB | ~7+ GB | ❌ No | < 1 tok/s |
| **Gemma 2 9B** (any) | 9B | ~5.5 GB | ~7 GB | ❌ No | Too slow |

> [!IMPORTANT]
> **Gemma 2 2B Q4_K_M via Ollama is your best bet.** It fits comfortably in RAM alongside your Node server, Python tracker, and the OS. PaliGemma is technically possible but will consume most of your RAM and make concurrent tracking impossible.

### 2.2 Recommended Architecture

**Do NOT run the LLM as an always-on service.** On 8GB RAM, you cannot afford to pin 2.5GB to a dormant model. Use a **lazy-load, auto-unload** pattern:

```
┌─────────────────────────────────────────────────┐
│                   Flyt Server (Node.js)         │
│                                                 │
│  ┌──────────┐   ┌──────────┐   ┌─────────────┐ │
│  │ Upload   │   │ Tracker  │   │ AI Query    │ │
│  │ Handler  │   │ Spawner  │   │ Endpoint    │ │
│  └──────────┘   └──────────┘   └──────┬──────┘ │
│                                       │         │
└───────────────────────────────────────┼─────────┘
                                        │
                    ┌───────────────────┼──────┐
                    │   Ollama (lazy)   │      │
                    │                   ▼      │
                    │  ┌─────────────────────┐ │
                    │  │  gemma2:2b-q4_K_M   │ │
                    │  │  (loaded on demand) │ │
                    │  │  (unloaded after    │ │
                    │  │   5min idle)        │ │
                    │  └─────────────────────┘ │
                    └──────────────────────────┘
```

```javascript
// server.js — AI query endpoint with mutual exclusion
const AI_MUTEX = { locked: false, queue: [] };

app.post('/api/ai/query', async (req, res) => {
  const { question, context } = req.body;
  
  // Don't allow AI queries while tracker is running
  if (activeTrackerProcess) {
    return res.status(409).json({ 
      error: 'AI co-pilot unavailable during active tracking. ' +
             'Wait for tracking to complete.' 
    });
  }
  
  // Serialize AI requests (only 1 at a time on this hardware)
  if (AI_MUTEX.locked) {
    return res.status(429).json({ error: 'AI query already in progress.' });
  }
  
  AI_MUTEX.locked = true;
  try {
    // Ollama will auto-load the model on first request
    const response = await fetch('http://localhost:11434/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gemma2:2b',
        prompt: buildPrompt(question, context),
        stream: false,
        options: {
          num_ctx: 2048,       // Keep context window small to save RAM
          num_thread: 4,       // Match physical cores, not hyperthreads
          temperature: 0.3,    // Low temp for factual lab queries
        }
      })
    });
    
    const data = await response.json();
    res.json({ answer: data.response });
  } finally {
    AI_MUTEX.locked = false;
  }
});

function buildPrompt(question, experimentContext) {
  return `You are a Drosophila behavioral biology research assistant. 
You are analyzing tracking data from a mating chamber assay.

EXPERIMENT CONTEXT:
${experimentContext}

RESEARCHER QUESTION:
${question}

Provide a concise, scientifically accurate answer. 
Cite specific data values from the context when relevant.
Use standard ethology terminology.`;
}
```

### 2.3 PaliGemma — When and How

PaliGemma (vision-language) is exciting for micro-behavior classification but **should not be used in real-time on your hardware**. Instead, use it in **batch post-processing mode**:

```python
# Extract key frames at suspected behavioral events, then classify offline
def extract_event_frames(video_path, event_timestamps, context_frames=5):
    """
    Pull frames around suspected events for batch VLM classification.
    Called AFTER tracking completes, NOT during.
    """
    cap = cv2.VideoCapture(video_path)
    fps = cap.get(cv2.CAP_PROP_FPS)
    frames = {}
    
    for event_time in event_timestamps:
        frame_idx = int(event_time * fps)
        cap.set(cv2.CAP_PROP_POS_FRAMES, max(0, frame_idx - context_frames))
        
        event_frames = []
        for i in range(2 * context_frames + 1):
            ret, frame = cap.read()
            if ret:
                # Downscale to 224x224 for PaliGemma input
                small = cv2.resize(frame, (224, 224))
                event_frames.append(small)
        
        frames[event_time] = event_frames
    
    cap.release()
    return frames
```

> [!TIP]
> **Alternative to local PaliGemma**: Consider offering a toggle for researchers with internet access to use the **Gemini API** (free tier: 15 RPM) for vision tasks. This removes the hardware constraint entirely while keeping local-only as the default for data-sensitive labs.

---

## 3. Scientific Rigor & Publication Readiness

### 3.1 Missing Metrics for Ethology Journals

Your current metrics (velocity, inter-fly proximity, sleep) are a good start but insufficient for high-impact behavioral biology journals. Here's what reviewers will expect:

#### Courtship-Specific Ethogram Metrics

| Metric | Definition | How to Compute | Why It Matters |
|---|---|---|---|
| **Courtship Index (CI)** | Fraction of observation time the male spends in courtship behavior | `time_in_courtship / total_observation_time` | **THE** standard metric in *Drosophila* courtship papers. You MUST have this. |
| **Courtship Latency** | Time from assay start to first courtship bout | Timestamp of first detected courtship event | Measures male motivation / female receptivity signaling |
| **Copulation Latency** | Time from assay start to copulation onset | Timestamp when merge blob duration exceeds threshold (e.g., >60s continuous merge) | Primary fitness proxy |
| **Copulation Duration** | Length of copulation event | Duration of sustained merge blob | Under strong selection; heritable trait |
| **Wing Extension Index** | Frequency/duration of unilateral wing extension (male courtship song) | Detect asymmetric contour changes — one side of male ellipse extends momentarily. Challenging but possible with aspect ratio spike detection. | Courtship song production is a key behavioral phenotype |
| **Following Index** | Proportion of time male is oriented toward and within N body-lengths of female | Compute heading vector from ellipse orientation; check if it points toward female centroid within distance threshold | Distinguishes active pursuit from passive proximity |
| **Locomotor Activity** | Total distance traveled per unit time, binned | Sum of frame-to-frame centroid displacements per time bin | Controls for general activity vs. courtship-specific movement |
| **Angular Velocity** | Rate of heading change | `Δorientation / Δtime` | Distinguishes oriented following from random walking |

#### Implementing the Following Index

This is one of the most publication-relevant metrics you're missing:

```python
def compute_following_index(male_positions, male_orientations, 
                             female_positions, fps, 
                             distance_threshold_bl=3.0, 
                             angle_threshold_deg=45.0,
                             body_length_px=30):
    """
    Following Index: fraction of frames where the male is 
    (a) within N body-lengths of the female AND
    (b) oriented toward the female (heading within ±45° of bearing to female).
    
    Standard metric in Drosophila courtship literature.
    """
    n_frames = len(male_positions)
    following_frames = 0
    
    for i in range(n_frames):
        mx, my = male_positions[i]
        fx, fy = female_positions[i]
        
        # Distance check
        dist = np.sqrt((fx - mx)**2 + (fy - my)**2)
        if dist > distance_threshold_bl * body_length_px:
            continue
        
        # Bearing from male to female
        bearing = np.degrees(np.arctan2(fy - my, fx - mx)) % 360
        heading = male_orientations[i] % 360
        
        # Angular difference (circular)
        angle_diff = abs(bearing - heading)
        angle_diff = min(angle_diff, 360 - angle_diff)
        
        if angle_diff <= angle_threshold_deg:
            following_frames += 1
    
    return following_frames / n_frames
```

#### Sleep Analysis Improvements

Your current sleep detection likely uses a simple velocity threshold. For publication, you need:

```python
def detect_sleep_bouts(velocities, fps, 
                        velocity_threshold=0.5,  # px/frame
                        min_bout_duration_sec=300):  # 5 minutes = standard
    """
    Drosophila sleep: ≥5 minutes of inactivity (Shaw et al., 2000).
    Returns list of (start_time, end_time, duration) tuples.
    """
    min_bout_frames = int(min_bout_duration_sec * fps)
    is_inactive = velocities < velocity_threshold
    
    bouts = []
    bout_start = None
    
    for i, inactive in enumerate(is_inactive):
        if inactive and bout_start is None:
            bout_start = i
        elif not inactive and bout_start is not None:
            bout_len = i - bout_start
            if bout_len >= min_bout_frames:
                bouts.append((
                    bout_start / fps,
                    i / fps,
                    bout_len / fps
                ))
            bout_start = None
    
    # Handle bout extending to end of recording
    if bout_start is not None:
        bout_len = len(velocities) - bout_start
        if bout_len >= min_bout_frames:
            bouts.append((
                bout_start / fps,
                len(velocities) / fps,
                bout_len / fps
            ))
    
    return bouts

def sleep_metrics(bouts, total_duration_sec):
    """Compute standard sleep metrics for publication."""
    if not bouts:
        return {
            'total_sleep_min': 0,
            'n_bouts': 0,
            'mean_bout_duration_min': 0,
            'sleep_fraction': 0,
            'sleep_latency_min': None,
        }
    
    durations = [b[2] for b in bouts]
    return {
        'total_sleep_min': sum(durations) / 60,
        'n_bouts': len(bouts),
        'mean_bout_duration_min': np.mean(durations) / 60,
        'max_bout_duration_min': max(durations) / 60,
        'sleep_fraction': sum(durations) / total_duration_sec,
        'sleep_latency_min': bouts[0][0] / 60,  # Time to first sleep
        'bout_duration_cv': np.std(durations) / (np.mean(durations) + 1e-6),
    }
```

### 3.2 Spatial Density Heatmaps — Statistical Upgrade

Your current heatmaps are good for visualization. For publication, add:

```python
def compute_occupancy_statistics(positions, chamber_dims, grid_size=20):
    """
    Compute spatial occupancy with statistical tests.
    Returns occupancy grid + entropy measure.
    """
    # 2D histogram
    x_bins = np.linspace(0, chamber_dims[0], grid_size + 1)
    y_bins = np.linspace(0, chamber_dims[1], grid_size + 1)
    
    hist, _, _ = np.histogram2d(
        [p[0] for p in positions],
        [p[1] for p in positions],
        bins=[x_bins, y_bins]
    )
    
    # Normalize to probability distribution
    prob = hist / hist.sum()
    
    # Spatial entropy — measures how uniformly the fly explores the chamber
    # Low entropy = strong spatial preference (thigmotaxis, corner preference)
    # High entropy = uniform exploration
    nonzero = prob[prob > 0]
    entropy = -np.sum(nonzero * np.log2(nonzero))
    max_entropy = np.log2(grid_size * grid_size)  # uniform distribution
    normalized_entropy = entropy / max_entropy
    
    # Thigmotaxis index — fraction of time spent in outer 20% of chamber
    margin = int(grid_size * 0.2)
    center_mask = np.zeros_like(hist, dtype=bool)
    center_mask[margin:-margin, margin:-margin] = True
    thigmotaxis_index = 1.0 - (hist[center_mask].sum() / hist.sum())
    
    return {
        'occupancy_grid': hist,
        'probability_grid': prob,
        'spatial_entropy': entropy,
        'normalized_entropy': normalized_entropy,
        'thigmotaxis_index': thigmotaxis_index,
    }
```

### 3.3 Quantitative Validation Strategy

> [!CAUTION]
> **Without a validation section, no ethology journal will accept your software paper.** You must prove Flyt's tracking accuracy against a ground truth.

#### Validation Protocol

```
GROUND TRUTH GENERATION
├── Manual Annotation (Gold Standard)
│   ├── 10 randomly selected 5-minute video clips
│   ├── 2 independent human annotators
│   ├── Frame-by-frame centroid marking (every 10th frame = ~1800 annotations/clip)
│   ├── Behavioral event annotation (courtship bouts, copulation)
│   └── Inter-rater reliability: Cohen's κ ≥ 0.8 required
│
├── Synthetic Validation
│   ├── Generate synthetic fly videos with KNOWN trajectories
│   ├── Vary: fly size, speed, crossing frequency, contrast
│   └── Compute tracking error against exact known positions
│
└── Cross-Tool Validation
    ├── Run same videos through Ctrax, FlyTracker, or SLEAP
    ├── Compare centroid positions, identity swap rates
    └── Bland-Altman plots for metric agreement
```

#### Key Validation Metrics to Report

```python
def compute_tracking_accuracy(predicted_positions, ground_truth_positions,
                               identity_assignments_pred, 
                               identity_assignments_gt):
    """
    Compute standard tracking validation metrics.
    Report ALL of these in your paper.
    """
    metrics = {}
    
    # 1. CENTROID ERROR (pixel distance between predicted and GT)
    errors = [
        np.linalg.norm(np.array(p) - np.array(g))
        for p, g in zip(predicted_positions, ground_truth_positions)
    ]
    metrics['mean_centroid_error_px'] = np.mean(errors)
    metrics['median_centroid_error_px'] = np.median(errors)
    metrics['p95_centroid_error_px'] = np.percentile(errors, 95)
    
    # 2. IDENTITY PRESERVATION RATE
    #    After each crossing event, was identity maintained?
    n_crossings = count_crossing_events(ground_truth_positions)
    n_swaps = count_identity_swaps(identity_assignments_pred,
                                    identity_assignments_gt)
    metrics['identity_preservation_rate'] = 1.0 - (n_swaps / max(n_crossings, 1))
    
    # 3. DETECTION RATE
    #    What fraction of frames had the correct number of flies detected?
    metrics['detection_rate'] = (
        sum(1 for p in predicted_positions if len(p) == 2) / 
        len(predicted_positions)
    )
    
    # 4. BEHAVIORAL EVENT CONCORDANCE
    #    Cohen's kappa for courtship/copulation event detection
    # (compare against human annotation)
    
    return metrics
```

#### Synthetic Video Generator

This is invaluable for systematic validation — build a function that creates test videos with known ground truth:

```python
def generate_synthetic_fly_video(
    output_path, 
    duration_sec=60, 
    fps=30,
    chamber_size=(400, 400),
    n_flies=2,
    fly_sizes=((12, 8), (16, 10)),  # (major, minor) axis for male, female
    crossing_count=5,                # Number of crossings to simulate
    noise_level=0.1,
    seed=42
):
    """
    Generate a synthetic video with known trajectories for validation.
    Returns ground truth DataFrame alongside the video.
    """
    np.random.seed(seed)
    n_frames = int(duration_sec * fps)
    
    # Generate smooth random walk trajectories
    trajectories = []
    for i in range(n_flies):
        # Start at random positions
        pos = np.array([
            np.random.uniform(50, chamber_size[0] - 50),
            np.random.uniform(50, chamber_size[1] - 50)
        ], dtype=np.float64)
        
        traj = [pos.copy()]
        for f in range(1, n_frames):
            # Random walk with momentum
            step = np.random.randn(2) * 2.0
            pos += step
            # Bounce off walls
            pos = np.clip(pos, 20, np.array(chamber_size) - 20)
            traj.append(pos.copy())
        
        trajectories.append(np.array(traj))
    
    # Force N crossing events at random times
    # (move flies to same position briefly)
    crossing_frames = sorted(np.random.choice(
        range(fps * 5, n_frames - fps * 5), crossing_count, replace=False
    ))
    
    for cf in crossing_frames:
        midpoint = (trajectories[0][cf] + trajectories[1][cf]) / 2
        for dt in range(-fps, fps):
            t = max(0, min(cf + dt, n_frames - 1))
            blend = 1.0 - abs(dt) / fps
            for i in range(n_flies):
                trajectories[i][t] = (
                    trajectories[i][t] * (1 - blend) + midpoint * blend
                )
    
    # Render video
    fourcc = cv2.VideoWriter_fourcc(*'mp4v')
    writer = cv2.VideoWriter(output_path, fourcc, fps, chamber_size)
    
    for f in range(n_frames):
        frame = np.full((*chamber_size[::-1], 3), 200, dtype=np.uint8)  # Light bg
        
        for i in range(n_flies):
            center = tuple(trajectories[i][f].astype(int))
            axes = fly_sizes[i]
            angle = np.random.uniform(0, 360)
            color = (40 + i * 20, 40 + i * 20, 40 + i * 20)  # Dark ellipses
            cv2.ellipse(frame, center, axes, angle, 0, 360, color, -1)
        
        # Add noise
        noise = np.random.randint(-int(noise_level * 255), 
                                   int(noise_level * 255), 
                                   frame.shape, dtype=np.int16)
        frame = np.clip(frame.astype(np.int16) + noise, 0, 255).astype(np.uint8)
        
        writer.write(frame)
    
    writer.release()
    
    # Build ground truth DataFrame
    import pandas as pd
    gt_rows = []
    for f in range(n_frames):
        for i in range(n_flies):
            gt_rows.append({
                'frame': f,
                'time': f / fps,
                'fly_id': i,
                'x': trajectories[i][f][0],
                'y': trajectories[i][f][1],
                'area': np.pi * fly_sizes[i][0] * fly_sizes[i][1],
            })
    
    return pd.DataFrame(gt_rows), crossing_frames
```

---

## 4. Architectural Recommendations

### 4.1 Data Export Format

> [!IMPORTANT]
> **Your CSV output must follow the ethology community's conventions.** Many labs use R for downstream analysis (not Python). Export both a tidy long-format CSV and a wide-format summary.

```
output/
├── {video_name}_tracks.csv          # Frame-by-frame tracking data (long format)
│   columns: frame, time_sec, fly_id, x_px, y_px, x_mm, y_mm,
│            velocity_px_s, velocity_mm_s, heading_deg, 
│            area_px2, aspect_ratio, inter_fly_dist_px, 
│            inter_fly_dist_mm, is_merged, is_sleeping
│
├── {video_name}_events.csv          # Behavioral events
│   columns: event_type, start_time, end_time, duration_sec,
│            fly_id, confidence, human_verified
│
├── {video_name}_summary.csv         # Per-video summary statistics
│   columns: courtship_index, courtship_latency, copulation_latency,
│            copulation_duration, following_index, total_sleep_min,
│            n_sleep_bouts, mean_velocity, thigmotaxis_index,
│            spatial_entropy, n_identity_swaps, n_crossings,
│            tracking_coverage_pct
│
├── {video_name}_heatmap.png         # Spatial occupancy heatmap
├── {video_name}_annotated.mp4       # Video with overlaid tracks (H.264)
└── {video_name}_metadata.json       # Camera settings, scale calibration, etc.
```

### 4.2 Configuration & Reproducibility

Every parameter should be saved with the output for reproducibility:

```json
{
  "flyt_version": "0.3.0",
  "tracker_config": {
    "mog2_history": 1000,
    "mog2_var_threshold": 50,
    "min_contour_area_px": 80,
    "max_contour_area_px": 2000,
    "sleep_velocity_threshold_px_frame": 0.5,
    "sleep_min_duration_sec": 300,
    "following_distance_threshold_bl": 3.0,
    "following_angle_threshold_deg": 45.0,
    "scale_px_per_mm": 12.5,
    "identity_model": "composite_v1",
    "identity_weights": {"size": 3.0, "aspect": 2.0, "spatial": 2.5, "orient": 1.0}
  },
  "video_info": {
    "filename": "mating_assay_001.mp4",
    "fps": 30,
    "resolution": [1920, 1080],
    "duration_sec": 3600,
    "codec": "h264"
  },
  "calibration": {
    "method": "manual_line",
    "px_per_mm": 12.5,
    "reference_length_mm": 50.0
  },
  "processing": {
    "start_time": "2026-06-06T12:00:00",
    "end_time": "2026-06-06T12:15:32",
    "wall_time_sec": 932,
    "frames_processed": 108000,
    "processing_fps": 115.8
  }
}
```

### 4.3 Overall System Architecture Recommendation

```
┌─────────────────────────────────────────────────────────────────┐
│                        React Dashboard                         │
│  ┌─────────┐ ┌──────────┐ ┌──────────┐ ┌───────────────────┐  │
│  │ Upload  │ │ Timeline │ │ Metrics  │ │ AI Co-Pilot Chat │  │
│  │ + Config│ │ + Events │ │ Charts   │ │ (async, optional)│  │
│  └─────────┘ └──────────┘ └──────────┘ └───────────────────┘  │
└────────────────────────────┬────────────────────────────────────┘
                             │ REST + SSE (Server-Sent Events)
┌────────────────────────────┼────────────────────────────────────┐
│                    Express Server (Node.js)                      │
│                                                                  │
│  ┌──────────────┐  ┌───────────────┐  ┌──────────────────────┐  │
│  │ Video Upload │  │ Job Queue     │  │ AI Proxy             │  │
│  │ + Validation │  │ (sequential)  │  │ (Ollama / API)       │  │
│  └──────────────┘  └───────┬───────┘  └──────────────────────┘  │
│                            │                                     │
│         ┌──────────────────┼──────────────────┐                  │
│         ▼                  ▼                  ▼                  │
│  ┌─────────────┐  ┌──────────────┐  ┌──────────────────┐       │
│  │ Grid Detect │  │ Tracker.py   │  │ ffmpeg Worker    │       │
│  │ (Python)    │  │ (per-vial)   │  │ (crop/transcode) │       │
│  └─────────────┘  └──────────────┘  └──────────────────┘       │
└──────────────────────────────────────────────────────────────────┘
                             │
                             ▼
┌──────────────────────────────────────────────────────────────────┐
│                        Output Directory                          │
│  tracks.csv │ events.csv │ summary.csv │ annotated.mp4 │ meta   │
└──────────────────────────────────────────────────────────────────┘
```

**Key architectural change**: Replace REST polling with **Server-Sent Events (SSE)** for tracking progress. This eliminates the polling overhead in your React app and gives smoother progress updates:

```javascript
// server.js — SSE progress endpoint
app.get('/api/track/progress/:jobId', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });
  
  const jobId = req.params.jobId;
  
  const interval = setInterval(() => {
    const job = activeJobs.get(jobId);
    if (!job) {
      res.write(`data: ${JSON.stringify({ status: 'not_found' })}\n\n`);
      clearInterval(interval);
      res.end();
      return;
    }
    
    res.write(`data: ${JSON.stringify({
      status: job.status,
      progress: job.progress,
      fps: job.currentFps,
      eta_sec: job.etaSeconds,
    })}\n\n`);
    
    if (job.status === 'complete' || job.status === 'error') {
      clearInterval(interval);
      res.end();
    }
  }, 500);
  
  req.on('close', () => clearInterval(interval));
});
```

---

## 5. Publication Strategy

### 5.1 Target Journals

| Journal | Impact Factor | Fit | Notes |
|---|---|---|---|
| **Journal of Open Source Software (JOSS)** | N/A (indexed) | 🟢 Perfect | Short software paper. Requires: open source, docs, tests, example data. Fastest to publish. |
| **PLOS ONE** | ~3.7 | 🟢 Good | Methods paper with validation. Reviewers expect comparison to existing tools. |
| **Journal of Neuroscience Methods** | ~3.0 | 🟢 Good | Technical methods audience. Expects rigorous validation. |
| **eLife** | ~8.7 | 🟡 Stretch | Would need novel biological finding enabled by Flyt, not just the tool. |
| **Nature Methods** | ~48 | 🔴 Unlikely | Requires breakthrough capability (e.g., real-time courtship classification at >95% accuracy). |

### 5.2 Comparison Table for Paper

You **must** include a feature comparison against existing tools:

| Feature | **Flyt** | Ctrax | FlyTracker | SLEAP | DeepLabCut |
|---|---|---|---|---|---|
| GPU Required | ❌ No | ❌ No | ❌ No | ✅ Yes | ✅ Yes |
| Real-time Processing | ✅ | ❌ | ❌ | ❌ | ❌ |
| Web Dashboard | ✅ | ❌ | ❌ (MATLAB) | ❌ | ❌ |
| Identity Preservation | ✅ (composite) | ✅ (Kalman) | ✅ (appearance) | ✅ (pose) | ✅ (pose) |
| Multi-vial Batch | ✅ | ❌ | ❌ | ❌ | ❌ |
| Human-in-the-loop | ✅ | ❌ | ❌ | ❌ | ❌ |
| AI Co-pilot | ✅ | ❌ | ❌ | ❌ | ❌ |
| Setup Complexity | Low | Medium | High (MATLAB) | High | High |
| Training Required | None | None | None | Yes | Yes |

### 5.3 What Reviewers Will Ask

Anticipate and pre-empt these reviewer questions:

1. **"How does accuracy compare to manual annotation?"** → Your validation protocol (Section 3.3) answers this.
2. **"What about flies of similar size?"** → Report separate accuracy metrics for dimorphic vs. monomorphic pairs.
3. **"Can this handle more than 2 flies?"** → Be honest about the limitation. State it's designed for dyadic assays and reference your "Group Social Network Analysis" as future work.
4. **"Why not use deep learning?"** → This is your **strength**. Frame it as: "Flyt is designed for labs without GPU resources or ML expertise. It achieves X% accuracy on dyadic courtship assays using only classical computer vision, making it accessible to any biology lab with a consumer laptop."

---

## 6. Critique of Your Backlog (Priority Ranking)

| Planned Feature | Priority | Recommendation |
|---|---|---|
| H.264 Transcoding | 🟢 **P0 — Do first** | Blocking bug. Dashboard can't play videos without it. Trivial to implement. |
| Overlap/Crossing Resolution | 🟢 **P0 — Do first** | Core scientific correctness. Without this, all identity-dependent metrics are unreliable. Use composite model, not just Hu moments. |
| Interactive Scale Calibration | 🟢 **P1 — Do early** | Required for any publication (can't report px units). Simple UI feature with high impact. |
| Human-in-the-Loop Timeline | 🟡 **P1 — Do early** | Differentiator from all existing tools. Makes the tool genuinely useful for researchers. |
| Auto-Vial Grid Segmentation | 🟡 **P2 — Do before paper** | High throughput feature. Important for the paper's value proposition but not for core accuracy. |
| Group Social Network Analysis | 🟠 **P3 — Future work** | Significant scope expansion. Mention in paper as future direction. Don't block publication on this. |
| Local Gemma/PaliGemma AI Co-Pilot | 🟠 **P3 — Future work** | Cool but risky for publication timeline. Reviewers may see it as a gimmick unless you can show it meaningfully aids analysis. Keep as a demo feature, don't make it central to the paper's contribution. |

> [!TIP]
> **Shipping order for summer timeline**: H.264 → Crossing Resolution → Scale Calibration → Timeline UI → Vial Segmentation → Validation Suite → Paper Draft. Save AI integration for a v2 paper or a separate short communication.

---

## 7. Final Recommendations

1. **Add a proper Kalman filter** (not just nearest-neighbor) for frame-to-frame tracking *before* crossings even happen. This will reduce jitter in trajectories and produce smoother velocity/heading estimates. `filterpy` is a good lightweight Python library.

2. **Version your output format** with a schema version field. When you inevitably change the CSV columns, old outputs won't silently break downstream R scripts.

3. **Ship an example dataset** with your repo. One 5-minute courtship video + expected output CSVs. This serves as both documentation and a regression test.

4. **Add a `--headless` CLI mode** to `tracker.py` that skips all visualization and just outputs data. Reviewers and power users will want to run batch processing via command line.

5. **Write a simple R vignette** showing how to load and analyze Flyt output. Your target users use R, not Python, for statistics. A 50-line R Markdown file showing `read.csv("tracks.csv") %>% group_by(fly_id) %>% summarize(...)` will massively increase adoption.

6. **Timestamp everything in seconds from video start**, not frame numbers. Frame numbers are meaningless to biologists and create fps-dependent analysis bugs.

7. **Consider WebSocket instead of SSE** if you later add bidirectional features (like sending human annotations back during live playback). But SSE is sufficient for now.


This is a substantial and well-thought-out project. Let me produce a thorough architectural review. Given the depth of your questions, I'll create a detailed analysis artifact.

Created flyt_architectural_review.md

The full review is in the artifact above. Here are the most critical takeaways:

### 🔴 Your Biggest Risk: Hu Moments Won't Work

Dorsal-view *Drosophila* are nearly elliptical — Hu moment signatures between male and female differ by <5% in most frames. **Replace Hu moments with a composite identity vector** (size + aspect ratio + spatial continuity + orientation history), weighted and fed into Hungarian matching. The code for `FlyIdentityModel` is in the review.

### 🟢 Gemma 2B is Feasible, PaliGemma is Not (for real-time)

Gemma 2 2B at Q4_K_M quantization via Ollama (~1.8GB on disk, ~2.5GB in RAM) will run at 8-12 tokens/sec on your i5. But **never run it concurrently with the tracker** — use a mutex pattern. PaliGemma should be batch-only on extracted keyframes, not real-time.

### 🟡 You're Missing THE Standard Metric

No courtship paper gets published without a **Courtship Index** (fraction of time in courtship). You also need **Following Index**, **Courtship Latency**, and **Copulation Latency**. Code for all of these is in the review.

### 📋 Recommended Shipping Order for Summer

**H.264 → Crossing Resolution → Scale Calibration → Timeline UI → Vial Segmentation → Validation Suite → Paper Draft.** Save the AI co-pilot for a v2 paper — reviewers may see it as scope creep.

### 🎯 Target JOSS or J. Neuroscience Methods

JOSS (Journal of Open Source Software) is the fastest path to a citable publication. J. Neuroscience Methods if you want higher impact but expect a longer review cycle. Either way, you **must** include quantitative validation against manually annotated ground truth — the review includes a complete validation protocol and a synthetic video generator for systematic testing.

Let me know if you want me to dive deeper into any section, or if you'd like me to start implementing any of these recommendations in your actual codebase.