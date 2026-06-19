# Flyt Ratings & Research Impact Framework

---

## Rating (1–10): Functionality, Efficiency, Accuracy

Here’s an honest rating based on the current codebase — not the roadmap.

### Flyt PoC Ratings

| Dimension | Score | Summary |
|-----------|-------|---------|
| **Functionality** | **5 / 10** | Core upload → track → chart loop works; many UI features are cosmetic or broken |
| **Efficiency** | **6.5 / 10** | Lightweight and appropriate for CPU-only labs; not optimized yet |
| **Accuracy** | **3.5 / 10** | Fine for rough demos; not trustworthy for publication or courtship metrics |

**Overall PoC:** ~**5 / 10** — a solid demo skeleton, not a research tool yet.

---

### Functionality — 5/10

**What actually works**
- Video upload with async job polling (`UploadView` → `server.js` → `tracker.py`)
- Per-frame CSV export with positions, speed, proximity, activity
- Dashboard charts (velocity, proximity, heatmap) from real data
- Standalone tracker CLI

**What’s broken or fake**
- **K-01:** Video player shows the **original upload**, not the annotated track (`server.js` copies input → `tracked.mp4`)
- History tab is hardcoded mock data
- Settings modal doesn’t reach the backend
- Export PDF / Prism CSV buttons do nothing
- `outputType` and camera perspective UI are cosmetic

So: one real workflow exists, but roughly half the dashboard promises more than it delivers.

---

### Efficiency — 6.5/10

**Good choices**
- CPU-only OpenCV MOG2 — right call for i5 / 8 GB / no GPU
- Single Python child process, non-blocking Express API
- Monolithic PoC — low overhead, easy to reason about
- Async upload + polling — UI stays responsive

**Not optimized**
- Full-frame MOG2 every frame (no ROI masking yet)
- Annotated video written with `mp4v` then discarded in favor of a full file copy
- Metrics recomputed client-side on every CSV load
- No frame skipping, batching, or multi-vial in-memory ROI yet

For a PoC on modest hardware, the architecture is reasonable. It’s not tuned for long videos, 12-vial assays, or production throughput.

---

### Accuracy — 3.5/10

This is the weakest area — and the most important for a biology lab.

**Tracker limitations**
- Nearest-neighbor re-ID → **identity swaps** after overlap/crossing (`tracker.py:94-106`)
- Single merged contour → both flies get the same coordinates, proximity = 0
- No occlusion model, no Hungarian assignment, no area/Hu-moment signatures (despite `scipy` being listed)
- No upper area bound → cotton plug / large blobs can false-trigger
- Speed in **px/frame**, not px/sec — FPS not normalized

**Metric limitations**
- Courtship bouts: `proximity < 65px` rising edge — arbitrary, no bout duration
- Sleep: `activity < 10` for 150 frames — not standard ethological sleep definition
- Heatmap uses fly 1 only; fly 2 ignored
- No ground-truth validation, confidence scores, or human verification loop

On clean videos with flies that rarely touch, you might get ~60–70% usable trajectories. For courtship assays where contact is the point, accuracy drops sharply — likely unusable for publishing without manual correction.

---

### Context by use case

| Use case | Fit |
|----------|-----|
| Demo to a PI / proof the UI concept | **7/10** |
| Exploratory velocity/proximity on easy videos | **5/10** |
| Courtship index / sleep for a paper | **2/10** |
| Multi-vial high-throughput lab workflow | **1/10** |

---

### What would move the scores fastest

1. **H.264 annotated video** → Functionality **+1.5**
2. **ToxId-Light + occlusion handling** → Accuracy **+2–3**
3. **ROI masking + area bounds** → Accuracy **+1**, Efficiency **+0.5**
4. **Server-side metrics with validated thresholds** → Accuracy **+1**, Functionality **+0.5**
5. **Human-in-the-loop verification** → Accuracy **+2** (for publishable outputs)

Realistic post-refactor target: **Functionality 8 · Efficiency 7.5 · Accuracy 7** — if backlog items 1–3 land.

---

## Other Parameters & Metrics to Rate (Lab / Publication / Humanity)

For a behavioral biology tool you want to publish and actually help labs use, three technical scores aren’t enough. Researchers care whether they can **trust**, **cite**, **reproduce**, and **adopt** it — not just whether it runs.

Here’s a fuller rating framework, with **current PoC estimates** and **publish-ready targets**.

---

### 1. Scientific & Ethological Validity

Does it measure what biologists think it measures?

| Metric | What it means | Now | Publish target |
|--------|----------------|-----|----------------|
| **Construct validity** | Do outputs map to real behaviors (courtship bout, sleep, locomotion)? | **2/10** | 8+ |
| **Operational definitions** | Are thresholds documented and literature-backed? | **1/10** | 8+ |
| **Identity continuity** | Fly IDs stay correct through contact | **2/10** | 8+ |
| **Metric completeness** | Beyond xy/speed/proximity: bout duration, CI, latency, orientation | **3/10** | 7+ |
| **Assay coverage** | Courtship chamber, vials, group assays | **4/10** (2-fly only) | 7+ |
| **Units & calibration** | mm/s, mm distance, not raw pixels | **2/10** | 9+ |

**Why it matters for humanity:** Bad ethology software doesn’t just waste time — it produces **wrong biology**. For publication, this category matters more than UI polish.

---

### 2. Reproducibility & Provenance

Can another lab get the same results from the same video?

| Metric | What it means | Now | Publish target |
|--------|----------------|-----|----------------|
| **Determinism** | Same input → same output | **6/10** (mostly deterministic CV) | 9+ |
| **Run provenance** | Settings, video hash, version, timestamp logged | **1/10** | 9+ |
| **Parameter traceability** | Every threshold saved with results | **2/10** | 9+ |
| **Export reproducibility** | CSV + metadata + config bundled | **3/10** | 9+ |
| **Cross-machine consistency** | Works same on different laptops/OS | **4/10** (Windows-hardcoded paths) | 8+ |

**Gap today:** A researcher can’t answer “how was this courtship index calculated?” from the output alone.

---

### 3. Trust, Verification & Human-in-the-Loop

Can a biologist stake their paper on it?

| Metric | What it means | Now | Publish target |
|--------|----------------|-----|----------------|
| **Visual auditability** | Annotated video actually plays in browser | **2/10** (K-01) | 9+ |
| **Event review workflow** | Suspected bouts → jump → confirm/reject | **0/10** | 8+ |
| **Correction persistence** | Human labels update final metrics | **0/10** | 8+ |
| **Uncertainty reporting** | Confidence / occlusion flags per frame | **0/10** | 8+ |
| **False-positive transparency** | System flags low-quality runs before 10h jobs | **0/10** | 7+ |

**For behavioral biology:** Automation is only useful if a human can **verify** before publishing. This is Flyt’s biggest differentiator if you build it.

---

### 4. Validation & Benchmarking

Has the tool been tested against ground truth?

| Metric | What it means | Now | Publish target |
|--------|----------------|-----|----------------|
| **Ground-truth dataset** | Manually scored videos for validation | **0/10** | 8+ |
| **Tracking metrics** | MOTA, ID switches, fragmentation (or fly-specific equivalents) | **0/10** | 7+ |
| **Behavioral agreement** | Automated vs human rater (Cohen’s κ, ICC) | **0/10** | 8+ |
| **Assay-specific benchmarks** | Courtship, sleep, locomotion separately scored | **0/10** | 8+ |
| **Failure case library** | Documented where tracker breaks (glare, overlap, plug) | **2/10** (in docs only) | 8+ |

**Publication reality:** JOSS and ethology papers need **evidence the software works**, not just that it exists.

---

### 5. Usability for Non-Programmers

Will a grad student in a wet lab actually use it?

| Metric | What it means | Now | Publish target |
|--------|----------------|-----|----------------|
| **Install friction** | One-command or conda install | **4/10** | 8+ |
| **Workflow clarity** | Upload → diagnose → track → verify → export | **5/10** | 9+ |
| **Error messages** | Actionable, not stack traces | **4/10** | 8+ |
| **Settings discoverability** | Arena, sensitivity, FPS exposed and explained | **3/10** | 8+ |
| **Learning curve** | Usable without reading source code | **6/10** (UI is clean) | 8+ |
| **Accessibility** | Works without GPU, on lab laptops | **8/10** | 9+ |

Flyt already has an edge here: **CPU-only, local, no cloud** — huge for under-resourced labs.

---

### 6. Interoperability & Ecosystem Fit

Does it plug into how biologists already work?

| Metric | What it means | Now | Publish target |
|--------|----------------|-----|----------------|
| **Prism / R / Python export** | Ready for stats pipelines | **2/10** | 8+ |
| **SLEAP / DLC import** | Universal visualizer for pose data | **0/10** | 7+ |
| **Standard schemas** | BIDS-like or tidy CSV conventions | **3/10** | 8+ |
| **Batch processing** | Many videos, many vials | **2/10** | 7+ |
| **Integration with existing tools** | Ctrax, ToxTrac, JAABA workflows | **1/10** | 6+ |

**Impact angle:** Flyt doesn’t need to replace DeepLabCut — it can be the **verification + visualization + metrics layer** on top.

---

### 7. Open Science & Publication Readiness

Can you publish it as citable infrastructure?

| Metric | What it means | Now | Publish target |
|--------|----------------|-----|----------------|
| **Documentation** | Install, methods, limitations, examples | **6/10** (AGENTS.md strong; user docs weak) | 9+ |
| **License & repo** | MIT, public GitHub, releases | **?/10** (not packaged yet) | 10/10 |
| **Citable artifact** | DOI via Zenodo / JOSS | **0/10** | 10/10 |
| **Methods section template** | Text researchers paste into papers | **0/10** | 8+ |
| **Versioning & changelog** | Semantic releases | **2/10** | 9+ |
| **Community onboarding** | Issues, contributing guide, example data | **3/10** | 8+ |

Your `improvements.md` JOSS path is smart — JOSS rewards **engineering quality + docs**, not novel biology.

---

### 8. Ethical & Equity Impact

Does it actually help humanity, especially smaller labs?

| Metric | What it means | Now | Publish target |
|--------|----------------|-----|----------------|
| **Low-resource accessibility** | Runs on i5, 8 GB, no GPU | **8/10** | 9+ |
| **Data sovereignty** | Local-only, no upload to cloud | **9/10** | 10/10 |
| **Cost barrier** | Free vs commercial trackers | **9/10** (PoC) | 10/10 |
| **Global reproducibility** | Works in labs without HPC | **7/10** | 9+ |
| **Transparency over black-box AI** | Deterministic CV, auditable | **8/10** | 9+ |
| **Inclusive assay support** | Non-standard setups, messy videos | **3/10** | 7+ |

**Flyt’s humanitarian pitch is strong here:** democratize behavioral phenotyping for labs that can’t afford GPU clusters or proprietary software.

---

### 9. Maintainability & Longevity

Will it still help researchers in 5 years?

| Metric | What it means | Now | Publish target |
|--------|----------------|-----|----------------|
| **Modularity** | Separable tracker / metrics / UI | **3/10** (monolith) | 7+ |
| **Test coverage** | Unit + integration + golden videos | **0/10** | 8+ |
| **Dependency stability** | Pinned, conda-friendly | **5/10** | 8+ |
| **Extensibility** | New assays without rewriting core | **4/10** | 8+ |
| **Bus factor / governance** | Clear maintainer, lab ownership | **?/10** | 8+ |

---

### 10. Comparative Value

How does it compare to what researchers use today?

| Metric | What it means | Now | Publish target |
|--------|----------------|-----|----------------|
| **vs manual scoring** | Time saved with equal or better accuracy | **4/10** | 8+ |
| **vs Ctrax / ToxTrac** | Easier + modern UI + verification | **5/10** (UI ahead, tracking behind) | 7+ |
| **vs SLEAP/DLC** | Complementary, not competitive | **N/A** | 8+ as visualizer |
| **Unique value proposition** | What only Flyt does well | **5/10** | 8+ |

**Flyt’s publishable niche (my view):**

> Local, transparent, human-verifiable fly behavior pipeline for courtship and locomotion — built for labs without GPUs, with publication-grade audit trails.

Not “another tracker.” Not “AI ethology.” **Trustworthy automation with biologist oversight.**

---

### Suggested Composite Scorecard

Group into four pillars for papers, grants, and JOSS:

| Pillar | Sub-metrics | Current avg | Target for v1.0 |
|--------|-------------|-------------|-------------------|
| **Science** | Validity, validation, accuracy, metrics | **~2.5/10** | **8/10** |
| **Trust** | Verification, provenance, uncertainty, visual audit | **~1/10** | **8/10** |
| **Adoption** | Usability, install, interoperability, docs | **~4.5/10** | **8/10** |
| **Impact** | Equity, openness, citability, longevity | **~5.5/10** | **9/10** |

**Overall research-impact readiness today: ~3.5/10**  
**Overall PoC engineering readiness: ~5/10**

Impact potential is high; scientific trust is the bottleneck.

---

### Minimum bar before claiming “helps humanity”

Before a paper or JOSS submission, I’d want these **non-negotiables**:

1. **Validated on 3+ real lab videos** with human-scored ground truth
2. **Annotated H.264 video** that matches CSV timestamps
3. **Documented ethological definitions** for every exported metric
4. **Human verification UI** for at least courtship bouts
5. **One-click reproducible export** (data + config + version + DOI)
6. **Honest limitations section** (overlap, glare, vial assays)

That’s more important than adding AI or more charts.

---

### Metrics Flyt should eventually *output* (not just rate itself on)

These are what behavioral biologists will cite you for:

| Category | Metrics |
|----------|---------|
| **Locomotion** | Total distance, mean/max speed, turning rate, occupancy heatmap |
| **Courtship** | Courtship index, bout count, bout duration, latency to first bout, inter-bout interval |
| **Proximity** | Mean NND, time within X mm, approach/retreat events |
| **Sleep/rest** | Total sleep (literature-defined), bout length distribution, circadian bins |
| **Identity quality** | ID switch count, occlusion time %, mean confidence |
| **Quality control** | Tracking quality score, recommended/manual review flag |

---

## Post-Phase Audit — 2026-06-15

> **Baseline above:** ratings from **2026-06-14** (pre Phase 1/2/3 work).  
> **This section:** honest scorecard after Phases 1 & 3 shipped, Phase 2 ToxId reverted (2026-06-15).

Good question. The ratings in `comp2.5-benchmarks.md` were from **before** the three phases. Here's an honest scorecard of **what's actually fixed** vs still open.

---

### The big 3 (original scores)

| Dimension | Was | ~Now | What changed |
|-----------|-----|------|----------------|
| **Functionality** | 5/10 | **~6.5–7/10** | Annotated video works, verification UI, jump-to-frame, cleaner upload flow |
| **Efficiency** | 6.5/10 | **~7/10** | H.264 transcode replaces "copy original"; still full-frame MOG2, no ROI UI |
| **Accuracy** | 3.5/10 | **~3.5–4/10** | Pitch tracker unchanged — swaps/merge still there; ToxId reverted |

**Overall PoC:** was **~5/10** → now **~5.5–6/10** engineering, still **~3.5–4/10** for publication-grade science.

---

### The 5 "fastest wins" from the benchmark doc

| # | Item | Fixed? |
|---|------|--------|
| 1 | H.264 annotated video | ✅ **Yes** (Phase 1) |
| 2 | ToxId + occlusion | ❌ **No** — tried Phase 2, reverted |
| 3 | ROI masking + area bounds | ⚠️ **Half** — CLI `--roi` / `--min-area` exist; no draw UI; server uses `max-area=0` |
| 4 | Server-side metrics + validated thresholds | ⚠️ **Half** — courtship bouts in tracker + `events.json`; sleep still ad-hoc client-side |
| 5 | Human-in-the-loop verification | ✅ **Yes** (Phase 3) |

**Fixed: 2 full + 2 partial = ~3 of 5**

---

### Known issues (K-01 … K-14)

| ID | Was broken | Now |
|----|------------|-----|
| K-01 | Video showed original, not annotated | ✅ Fixed |
| K-02 | ID swap after crossing | ❌ Still open |
| K-03 | Merge → same point, proximity 0 | ❌ Still open (pitch behavior) |
| K-04 | Settings not wired | ❌ Still open |
| K-05 | Ad-hoc courtship/sleep metrics | ⚠️ Courtship verified via events; sleep still fake |
| K-06 | Mock history | ❌ Still open |
| K-07 | Export buttons fake | ❌ Still open |
| K-08 | Speed px/frame not px/sec | ❌ Still open |
| K-09 | No area bound | ⚠️ CLI exists; not used aggressively (`max=0`) |
| K-10 | Hardcoded run ID | ✅ Gone (shows run timestamp now) |
| K-11 | scipy unused | ✅ N/A (removed) |
| K-12 | Windows-only paths | ❌ Still open |
| K-13 | Noisy low-conf events | ⚠️ Hidden in UI by default |
| K-14 | No jump-to-frame | ✅ Fixed |

**Fully fixed: 4 · Partial: 3 · Still open: 6**

---

### Publication pillars (the 4 composite scores)

| Pillar | Was | ~Now | Fixed items |
|--------|-----|------|-------------|
| **Science** (~2.5) | **~3–3.5** | Verified courtship bouts, sustained bout detection, extra CSV columns — but no ground truth, swaps unchanged |
| **Trust** (~1) | **~5–6** | Visual audit ✅, event review ✅, confirm/reject ✅, occlusion/confidence columns ✅, jump-to-frame ✅ |
| **Adoption** (~4.5) | **~5.5** | Workflow clearer, `START.bat`, docs — settings/export/history still weak |
| **Impact** (~5.5) | **~5.5** | Unchanged (still local/free/CPU — packaging/JOSS not started) |

**Trust** is the pillar that moved the most (roughly **1 → 5–6**).

---

### Sub-metrics that flipped from "broken" to "working"

| Metric (from benchmarks) | Was | Now |
|--------------------------|-----|-----|
| Visual auditability | 2/10 | **~8/10** |
| Event review workflow | 0/10 | **~7/10** |
| Correction persistence | 0/10 | **~6/10** (`verification.json`) |
| Uncertainty reporting | 0/10 | **~4/10** (columns exist; not true re-ID confidence) |
| Determinism | 6/10 | **~6/10** (same) |
| Workflow clarity | 5/10 | **~6.5/10** |
| Demo to PI | 7/10 | **~8/10** |

Still **0 or ~1–2:** ground truth, MOTA/ID switches, Prism export, SLEAP import, DOI/JOSS, px→mm, identity continuity, construct validity for sleep/CI.

---

### The 6 "non-negotiables" before claiming publication-ready

| # | Requirement | Done? |
|---|-------------|-------|
| 1 | Validated on 3+ real lab videos + human ground truth | ❌ |
| 2 | Annotated H.264 video matches CSV timestamps | ✅ |
| 3 | Documented ethological definitions for every metric | ❌ |
| 4 | Human verification for courtship bouts | ✅ |
| 5 | One-click reproducible export (data + config + version) | ❌ |
| 6 | Honest limitations section | ⚠️ In docs (`AGENTS.md`, handoff), not user-facing |

**Done: 2 of 6 · Partial: 1**

---

### Plain summary

**Phases 1 & 3 fixed the "can I trust what I see?" problems** — video, sync, verify courtship, jump to frame.

**They did not fix the "is the tracking scientifically right?" problems** — ID swaps, merge behavior, sleep metric, Prism export, settings, validation dataset.

| Category | % fixed (rough) |
|----------|-----------------|
| Trust / verification metrics | **~60–70%** |
| Functionality / UI gaps | **~40%** |
| Scientific accuracy | **~10–15%** |
| Publication / export / packaging | **~5%** |

---

**Bottom line:** You fixed roughly **a third** of what the benchmark doc flagged, but **most of the science/accuracy bucket** is still open. That's why Phase 4 (settings, export, ROI) + real lab QC matter more than another tracking "upgrade."