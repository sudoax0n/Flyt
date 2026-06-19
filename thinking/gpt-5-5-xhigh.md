**Architectural Verdict**  
Flyt’s strongest publication angle is not “AI-powered ethology.” It is: **a transparent, CPU-first, locally reproducible Drosophila tracking and annotation system for low-resource labs**. Keep the core tracker deterministic, auditable, and benchmarked. Make AI optional, sandboxed, and clearly non-authoritative.

Your biggest technical risk is identity continuity during contact. Your biggest scientific risk is reporting elegant plots without quantified tracker error.

**Backlog Triage**  
Highest priority: scale calibration, ROI/vial detection with manual correction, identity confidence, human correction provenance, validation suite.

Medium priority: H.264 preview export, improved crossing resolver, batch processing.

Defer: local PaliGemma visual behavior classification and group social networks until the two-fly pipeline is validated. Those can become impressive, but they can also consume the summer.

**1. CPU Optimization**  
For 12-vial videos, do not spawn 12 parallel ffmpeg crop jobs as the main path. On an i5-8365U, decode the source video once, then process ROIs in Python using NumPy slicing. Only export cropped videos later if the user requests previews.

Recommended flow:

```python
for frame_idx, frame in enumerate(video):
    gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
    for roi in rois:
        patch = gray[roi.y:roi.y+roi.h, roi.x:roi.x+roi.w]
        mask = bg_models[roi.id].apply(patch, learningRate=lr)
        # threshold, morphology, connectedComponentsWithStats
```

For vial detection: sample sparse frames, compute a temporal median background, detect chamber/grid geometry once, then let the user approve/edit ROIs. Use `connectedComponentsWithStats` for binary blob stats and only call contour/Hu logic on candidate blobs. Disable MOG2 shadow detection unless you prove it helps; reflective acrylic and cotton plugs often turn shadow logic into false foreground.

For H.264, make it a preview/export stage:

```bash
ffmpeg -i input.mp4 -vf "crop=w:h:x:y" -c:v libx264 -preset veryfast -crf 24 -pix_fmt yuv420p -movflags +faststart out.mp4
```

If you must create 12 cropped videos, use one `filter_complex` with `split` and 12 crops, not 12 separate decodes. Limit concurrency to 1-2 jobs and expose a queue in Node.

**2. Crossing Resolution**  
Hungarian + size average + Hu moments is a reasonable upgrade, but it is not robust enough by itself.

It will break when: the female and male have similar apparent size, wings change silhouette, the male is partly hidden under the female, flies touch the wall or cotton plug, glare splits blobs, MOG2 absorbs stationary flies, or a contact lasts many frames during courtship/copulation.

Better model: treat contact as an **occlusion segment**, not a frame-by-frame assignment problem.

1. Track normal frames with Kalman prediction plus gated assignment.  
2. When two blobs merge, create a merged “occlusion group” and freeze individual identities.  
3. When the blob splits, score the two possible assignments over the next 10-30 frames.  
4. Pick the assignment with best continuity of position, velocity, area, aspect ratio, orientation, and appearance.  
5. Store `identity_confidence` and `occlusion_flag` in the output.

For two flies, you do not even need Hungarian at every split. There are only two assignment hypotheses.

Useful cost sketch:

```python
def hu_log(contour):
    h = cv2.HuMoments(cv2.moments(contour)).ravel()
    return -np.sign(h) * np.log10(np.abs(h) + 1e-30)

cost = (
    3.0 * mahalanobis_position +
    1.0 * abs(np.log(area / track.area_med)) +
    0.8 * abs(aspect - track.aspect_med) +
    0.5 * cosine_orientation_penalty +
    0.3 * np.linalg.norm(hu - track.hu_med)
)
```

Use rolling medians/MAD rather than simple means. Hu moments are noisy; area, aspect ratio, ellipse orientation, and short-horizon trajectory continuity will often carry more signal.

**3. Local AI Reality Check**  
Text-only Gemma 2 2B in a quantized GGUF build is realistic on 8GB RAM for short, low-volume Q&A. Google’s Ollama integration notes that Ollama/llama.cpp use quantized GGUF variants for lower compute use, and Ollama’s Gemma 2 2B Q5 blob is around 1.9GB with an 8K context window. That is usable, but not fast or magically reliable.

PaliGemma is a poor fit for real-time visual classification on this hardware. Google documents PaliGemma/PaliGemma 2 as 3B+ vision-language models; CPU-only video inference will be slow and memory-hungry. If you want local visual behavior detection, train a small task-specific classifier on cropped frames or track-derived features, then run it through ONNX Runtime.

Recommended architecture:

- `flyt-core`: Python tracking package and CLI.
- `flyt-server`: Node job orchestration, uploads, progress, auth-free localhost UI.
- `flyt-ai`: optional local sidecar, disabled by default.
- Use Ollama first for ease; use llama.cpp server later if you need tighter memory/thread control.
- Set small context, one request at a time, idle unload, low process priority.
- Never let the LLM compute science directly from raw CSV. Use DuckDB/SQLite queries and pass the model only summarized, verified tables.
- For “write Results,” generate a draft from locked statistics plus provenance, not free-form claims.

If you are open to newer models, Gemma 3n E2B is more aligned with low-resource multimodal devices than PaliGemma, according to Google’s current Gemma 3n docs.

**4. Publication-Grade Additions**  
Add outputs that reviewers care about:

- Calibration: px/mm, calibration residual, lens distortion note.
- Tracking QC: detection rate, occlusion fraction, ID confidence, frame drops, ROI confidence.
- Body features: body length/width, orientation, angular velocity, eccentricity.
- Social features: distance in mm and body lengths, relative bearing, male orientation to female, following/chasing, contact duration, latency to courtship/contact/copulation.
- Sleep: use the standard >=5 min inactivity definition, but report threshold sensitivity.
- Event annotation: user labels should become versioned training/correction data, not just dashboard bookmarks.
- Provenance: video hash, config JSON/YAML, Flyt version/git SHA, OpenCV/ffmpeg versions, calibration, ROI masks, OS, timestamp.
- Export: CSV plus Parquet/HDF5 and a compact `analysis_manifest.json`.

Your comparison set should include Ctrax/FlyTracker-style classical tracking, idTracker/idtracker.ai for identity continuity, JAABA for interactive behavior annotation, and DeepLabCut/SLEAP for pose-estimation context.

**Validation Plan**  
Build a benchmark before adding more features.

- Manually annotate stratified frames: clean motion, crossings, wall contact, cotton-plug region, glare, low activity, high activity.
- Use 2 annotators for a subset to estimate human disagreement.
- Report centroid error in px/mm, detection precision/recall, ID switches/hour, IDF1, MOTA/HOTA, occlusion recovery success, orientation error.
- Validate behavior events with precision/recall/F1 and timing error against human labels.
- Run leave-one-video/day/camera-out tests.
- Benchmark runtime on the target i5 laptop: fps processed, RAM peak, time per 10-min video.
- Include synthetic stress tests with fly-like ellipses over mesh texture where true coordinates are known.
- Biologically validate by reproducing known effects: sex size dimorphism, courtship proximity/orientation patterns, and sleep/activity summaries.

**Sources**  
Useful anchors: [Ctrax](https://ctrax.sourceforge.net/), [idTracker Nature Methods](https://www.nature.com/articles/nmeth.2994), [JAABA](https://jaaba.sourceforge.net/), [DeepLabCut](https://www.nature.com/articles/s41593-018-0209-y), [SLEAP](https://www.nature.com/articles/s41592-022-01426-1.pdf), [Drosophila social behavior automation](https://pmc.ncbi.nlm.nih.gov/articles/PMC2679418/), [Drosophila sleep definition](https://academic.oup.com/genetics/article/205/4/1373/6067226), [Gemma with Ollama](https://ai.google.dev/gemma/docs/integrations/ollama), [PaliGemma docs](https://ai.google.dev/gemma/docs/paligemma), [Gemma 3n docs](https://ai.google.dev/gemma/docs/gemma-3n), [HOTA tracking metric](https://arxiv.org/abs/2009.07736).