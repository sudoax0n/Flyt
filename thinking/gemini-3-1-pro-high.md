# Flyt: Architectural Review & Scientific Evaluation

This document provides a critical evaluation of the Flyt (formerly DrosUI) tracking application architecture, addressing your planned backlog and offering recommendations to elevate the project to publication-grade status.

## 1. Algorithmic Optimization (CPU Constraints)

Given the target hardware (i5-8365U, 8GB RAM, No GPU), your primary enemy is memory swapping and CPU thermal throttling.

### Multi-vial Grid Detection & Crop-splitting
> [!WARNING]
> **Do not spawn 12 parallel `ffmpeg` instances.** 
> Transcoding video is incredibly CPU-intensive. Running 12 simultaneous H.264 encoders on a 4-core i5 will result in resource starvation, UI freezing, and thermal throttling.

**Architectural Suggestion:**
Instead of physically splitting the video on disk, implement **Logical Cropping (Regions of Interest - ROIs)** in memory.
1. **Grid Detection:** Use OpenCV's `cv2.findContours` combined with polygonal approximation (`cv2.approxPolyDP`) to find the rectangular vials.
2. **Single Pass Processing:** Read the video frame *once*. Apply bounding box masks for the 12 vials, and run your MOG2 + tracking logic on the 12 ROIs sequentially or using lightweight Python `multiprocessing` pools.
3. **Frontend Playback:** Stream the original uncropped H.264 video to the Vite frontend. Pass the ROI coordinates via the Express API and draw the 12 vial boundaries using SVG or HTML5 Canvas overlays right over the video. This saves massive amounts of disk I/O and CPU time.

### Crossing-Resolution Model (Identity Preservation)
Your proposed model (Hungarian Matching + Hu-Moments + Size Averages) is a solid classical CV approach, but it will fail under biological edge cases.

> [!CAUTION]
> **Edge Cases that will break Hu-Moments:**
> 1. **Wall-walking:** The 2D projection of a fly on the wall is a thin line, drastically altering its Hu-Moments and perceived size compared to walking on the floor.
> 2. **Prolonged Copulation:** Mating can last 20+ minutes. If you rely on a static historical size average, the tracker might lose context.
> 3. **The Cotton Plug:** High-contrast backgrounds (white plug vs. dark fly) can confuse MOG2 shadow detection, causing momentary tracking loss.

**Algorithmic Improvements:**
*   **Kalman Filters:** Implement a Kalman Filter for each fly. When two blobs merge into one, the Kalman filter predicts where they *should* go based on their entry velocity and trajectory. When they split, the Hungarian solver uses the Kalman predictions + current positions to re-assign IDs, reducing reliance purely on shape.
*   **Rolling Buffers:** Instead of an absolute historical size average, maintain a rolling queue (e.g., the last 60 frames of valid size/shape).
*   **Math Optimization:** Use `scipy.optimize.linear_sum_assignment` for the Hungarian algorithm. It is highly optimized with a C backend and is much faster than custom implementations.

---

## 2. Local AI Integration (Gemma / PaliGemma)

> [!IMPORTANT]
> **Hardware Reality Check:** 8GB of shared RAM (handling Windows 10/11, Node, Vite, Python, OpenCV, and an LLM) is a critical bottleneck. 

### Feasibility
*   **PaliGemma (Vision-Language):** Highly unlikely to run smoothly. Processing video frames through a local VLM on 8GB RAM without a GPU will result in severe out-of-memory (OOM) errors or massive swap-file usage, rendering the PC unusable.
*   **Gemma 2 2B (Text-only):** Feasible, provided strict memory management is enforced.

### Architectural Recommendations
1. **Engine:** Do not use Ollama as it runs a persistent background daemon. Instead, use `llama.cpp` directly (via a Python binding like `llama-cpp-python` or Node wrapper).
2. **Quantization:** You MUST use heavily quantized GGUF models. A `Q4_K_M` (4-bit) quantization of a 2B model will require around 1.5GB to 2GB of RAM.
3. **Just-in-Time Loading:** The AI model should *only* be loaded into memory when the user explicitly opens the "AI Co-Pilot" UI, and must be aggressively unloaded from memory the moment they close it. Do not allow the tracker and the LLM to run simultaneously.
4. **RAG implementation:** Feed the tracked CSV data into a lightweight local SQLite database. When the user asks a question, write a script to query the DB and inject the statistical summary into the Gemma prompt, rather than feeding raw CSV text (which will blow up the context window).

---

## 3. Scientific Rigor & Publishing

To get Flyt published in journals like *Behavior Genetics*, *Journal of Neurogenetics*, or *Methods in Ecology and Evolution*, the software must be validated quantitatively against existing gold standards.

### Enhancing Metrics for Peer Review
Basic velocity and sleep are good, but to make Flyt stand out:
1. **Orientation Vector:** You need to track the head vs. tail. Male Drosophila *orient* towards females during courtship. You can achieve this by calculating the angle of the major axis of the fitted ellipse (`cv2.fitEllipse`). The sharper end is usually the head.
2. **Courtship Index (CI):** Calculate the fraction of time the male spends actively following or orienting toward the female.
3. **Ethograms:** Generate standard behavioral ethograms—a timeline chart showing exactly when specific states (walking, sleeping, courting) occurred over the duration of the assay.
4. **Tortuosity:** Calculate the straightness of the path. Drunk or mutant flies often have highly tortuous paths.

### Quantitative Validation Protocol
You must prove that Flyt is just as accurate as manual human scoring or commercial tools (like Noldus EthoVision).

1. **Ground Truth Dataset:** Manually annotate 5 to 10 short videos (e.g., 5 minutes each) frame-by-frame using an open-source tool like BORIS. Record the exact X/Y coordinates and behavior states.
2. **Standardized Error Metrics:**
    *   *Tracking Accuracy:* Calculate the Root Mean Square Error (RMSE) in millimeters between Flyt's coordinates and the manual coordinates.
    *   *Identity Preservation:* Report the **ID Switch Rate** (how many times Male/Female IDs swapped during crossings).
    *   *Behavioral Accuracy:* Use a Confusion Matrix to report Precision, Recall, and F1-scores for detected states (e.g., "Sleep").
3. **Open Science:** When writing the manuscript, publish this ground-truth dataset alongside the Flyt GitHub repository so reviewers can replicate your accuracy claims.


Created flyt_architectural_review.md

I have reviewed the architecture and backlog for Flyt. I have compiled my feedback, architectural recommendations, and scientific publishing advice into a detailed document. 

You can review the full report here: [Flyt Architectural Review & Scientific Evaluation](file:///C:/Users/systemm/.gemini/antigravity/brain/916e83d8-4202-479f-89b5-872730f55dd7/flyt_architectural_review.md)

Here is a quick summary of the main points:

1. **Algorithmic Optimization:** Avoid spawning multiple `ffmpeg` processes for the 12 vials, as this will crash an i5 processor. Instead, process the vials as logical Regions of Interest (ROIs) in memory during a single OpenCV pass. For crossing-resolution, augment your Hungarian matching and Hu-Moments with **Kalman Filters** to predict trajectories, which will help resolve identities when flies merge and split.
2. **Local AI Integration:** Running a vision model like PaliGemma locally on 8GB of shared RAM is highly unlikely to succeed without crashing the system. However, running a quantized text model like **Gemma 2 2B** via `llama.cpp` is feasible for querying statistical data, provided it is strictly loaded *only* when needed and aggressively unloaded afterward.
3. **Scientific Rigor:** To get published, you should expand beyond velocity metrics to include **Orientation Vectors**, **Courtship Index**, and **Ethograms**. Most importantly, you will need to establish a quantitative validation protocol against a human-annotated ground-truth dataset to prove Flyt's accuracy with metrics like RMSE and Confusion Matrices.

Let me know if you would like to drill down into any specific algorithms, like implementing the Kalman Filter in Python or optimizing the Vite dashboard!