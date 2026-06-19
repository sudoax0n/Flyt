### 1. ALGORITHMIC OPTIMIZATION (CPU: i5-8365U)

**Multi-Vial Grid Segmentation**

* **Analysis:** Spawning 12 parallel `ffmpeg` child processes on an i5-8365U (4 cores, 8 threads) will cause severe context-switching overhead and I/O bottlenecking. 8GB RAM cannot sustain 12 concurrent video streams plus OS operations.
* **Edge Cases:** Camera misalignment, non-uniform lighting across the grid, acrylic glare.
* **Actionable Insight:** Do not split the video file. Read the source video once sequentially. Use OpenCV to detect the grid (Hough Line Transform or contour detection on an empty frame) to generate 12 static ROI (Region of Interest) coordinate bounding boxes. Pass the single frame into a processing loop, iterating through the 12 ROIs in memory.

**Crossing-Resolution Model**

* **Analysis:** Hungarian Matching + Size + Hu-Moments is insufficient. `Hu-Moments` are designed for rigid objects. Drosophila are highly articulated (wings extend, bodies bend during grooming/courtship), causing extreme intra-class variance in moment calculations.
* **Edge Cases:**
* *Copulation:* Sustained merging (minutes to hours). The centroid becomes static; orientation becomes ambiguous.
* *Wall Climbing:* Reflective acrylic walls create ghost contours. Plug in bottom-left creates contrast failure.


* **Actionable Insight:** Implement a Kalman Filter for kinematic prediction. When contours merge, suspend MOG2 updating for that blob. Predict future positions based on pre-merge velocity and trajectory. When the blob splits, match the new contours to the predicted trajectories. Use orientation angle (eigenvectors of the contour) rather than Hu-Moments to differentiate male (aligned to female abdomen) during courtship.

### 2. LOCAL AI INTEGRATION (MEMORY CONSTRAINT: 8GB)

**Hardware Reality Check**

* **Analysis:** An i5-8365U shares system memory with integrated graphics. Windows/Linux OS consumes ~2-3GB. Tracking operations will consume 1-2GB. Running Gemma 2 2B (Q4 quantization) requires ~2.5GB RAM. Running PaliGemma (Vision-Language) requires significantly more and is non-viable on CPU for real-time inference.
* **Actionable Insight:** Concurrent execution is impossible. You must architect a strict modal system: Tracking Mode XOR Analysis Mode.

**Architecture Specification**

* **Engine:** `llama.cpp`. It is the only option for optimized CPU-only execution via AVX2 instructions. Avoid Ollama (unnecessary overhead) and WebNN (immature CPU support).
* **Model:** Use Gemma 2 2B `GGUF` format, `Q4_K_M` quantization.
* **Implementation:** Bind `llama.cpp` to Node.js using `node-llama-cpp`. Unload the OpenCV tracking pipeline from memory completely before initializing the LLM context. Pass structured JSON outputs from your tracker into the LLM prompt for data querying. Abandon PaliGemma visual classification; offload visual heuristics to OpenCV.

### 3. SCIENTIFIC RIGOR & PUBLISHING

**Required Ethological Metrics**
To achieve publication-grade utility, basic proximity and velocity are inadequate. Implement the following computable metrics:

* **Bout Structure Analysis:** Define discrete behavioral states (e.g., stopping, walking, micromovement) using velocity thresholds over time windows (e.g., < 2 mm/s for > 5 seconds = rest).
* **Thigmotaxis (Wall-following):** Calculate the distance of the centroid to the defined arena boundary. Express as a ratio of time spent in the center zone vs. the perimeter.
* **Orientation/Heading:** Calculate the angle of the fly's major axis relative to the other fly. Courtship requires the male to face the female's posterior.

**Validation Methodology**
Journals require quantitative proof of accuracy against human baselines.

1. **Ground Truth Dataset:** Select 5 distinct 10-minute clips representing edge cases (dense clustering, courtship, varied lighting). Manually annotate fly centroids frame-by-frame using a tool like VGG Image Annotator (VIA).
2. **CLEAR Metrics:** Calculate standard tracking metrics:
* **MOTA (Multiple Object Tracking Accuracy):** Measures false positives, false negatives, and identity switches. Formula:
$MOTA = 1 - \frac{\sum_t (FN_t + FP_t + IDSW_t)}{\sum_t GT_t}$
* **MOTP (Multiple Object Tracking Precision):** Measures bounding box/centroid overlap accuracy.


3. **Publication Strategy:** Present Flyt as a high-efficiency, low-compute alternative to DeepLabCut/JAABA. Emphasize the "Human-in-the-Loop Timeline" as a solution to algorithmic uncertainty in low-resource environments.