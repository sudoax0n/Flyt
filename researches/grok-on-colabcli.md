\*\*Deep research complete\*\* (official GitHub repo, Google Developers Blog announcement \~June 5–11 2026, FAQ, community notes, and cross-checks as of June 15, 2026). 



\*\*Critical upfront finding:\*\* `google-colab-cli` is excellent for your exact use case (scriptable T4 provisioning, `colab new --gpu T4`, `exec -f`, upload/download, logging, named sessions) but \*\*native Windows support is not official yet\*\* (Linux/macOS primary). Use \*\*WSL2 Ubuntu\*\* — it works seamlessly and eliminates nearly all pitfalls.



All your requirements are addressed below, with \*\*copy-paste commands\*\*, honest technical assessment, and full deliverables.



\### 1. One-Page Quick Start (Windows via WSL) — First Successful `colab exec`



\*\*Prerequisites (one-time):\*\* WSL2 Ubuntu running, small test fly video (`assets/test\_videos/tiny\_fly\_clip.mp4`, few seconds, <50 MB ideal, top-down assay clip).



```bash

\# In WSL Ubuntu terminal

curl -LsSf https://astral.sh/uv/install.sh | sh

source \~/.bashrc

uv tool install google-colab-cli

colab version

colab auth          # browser OAuth or copy-paste code



SESSION="flyt-quickstart-hello"

VIDEO\_LOCAL="assets/test\_videos/tiny\_fly\_clip.mp4"

VIDEO\_REMOTE="/content/fly.mp4"



colab new -s $SESSION --gpu T4

colab status -s $SESSION   # confirm T4



colab upload -s $SESSION "$VIDEO\_LOCAL" "$VIDEO\_REMOTE"

colab install -s $SESSION opencv-python-headless numpy



echo '

import cv2, sys, numpy as np

print("="\*60)

print("FLYT + GOOGLE COLAB CLI T4 — QUICKSTART")

print("Python:", sys.version, "OpenCV:", cv2.\_\_version\_\_)

cap = cv2.VideoCapture("/content/fly.mp4")

ret, frame = cap.read(); cap.release()

if ret:

&#x20;   print(f"SUCCESS: Frame read! Shape {frame.shape}")

&#x20;   gray = cv2.cvtColor(frame, cv2.COLOR\_BGR2GRAY)

&#x20;   print(f"Mean gray: {gray.mean():.1f} (dark bg expected)")

else:

&#x20;   print("ERROR reading frame — check video")

print("PIPELINE READY for MOG2 experiments.")

print("="\*60)

' | colab exec -s $SESSION



colab stop -s $SESSION

```



\*\*Expected:\*\* Version prints + "SUCCESS: Frame read!" + reasonable mean intensity. This proves the full loop (provision, upload, install, exec from stdin or `-f`, basic OpenCV I/O on T4). Expand to full tracker scripts next.



\*\*Native Windows note:\*\* Possible with `pip install google-colab-cli` but TTY/console/repl and some paths are flaky — WSL is strongly preferred.



\### 2. Full SOP Document (researches/colab-sandbox-sop.md)



The complete, copy-paste-ready SOP (all 8 research areas + templates + every deliverable) has been written and saved here:



\*\*\*\*



It includes:

\- Exact Windows/WSL setup + auth + pitfalls

\- Recommended `flyt-colab-sandbox/` layout + sync strategy (Drive for videos, `exec -f` for scripts)

\- Full standard experiment loop with named sessions + checkpointing tips

\- Honest T4 assessment for classical MOG2 (see below)

\- Free vs Pro limits, disconnect handling, security/data residency mitigations

\- Manifest JSON template + automated `csv\_validator.py` gate logic

\- Prioritized experiments (ranked)

\- Decision matrix + risks/anti-patterns

\- One-page Quick Start embedded

\- Official links only



Open it in any Markdown viewer or VS Code — it is the living document you asked for.



\### 3. What Actually Benefits from T4 (Honest Assessment)



\*\*Classical OpenCV MOG2 + nearest-neighbor assignment is primarily CPU-bound.\*\* Standard `opencv-python-headless` does \*\*not\*\* automatically use the T4 GPU for background subtraction, contours, or assignment (no `cv2.cuda.MOG2` in the default wheel; custom CUDA builds break parity and add complexity).



\*\*Real T4 value for your constraints (i5 thermal-limited laptop):\*\*

\- Thermal/ergonomic offload + consistent long runs (no local throttling/fan noise).

\- Rapid parameter grids and batch processing of multiple assay clips.

\- Easy future optional small DL experiments (torch + CUDA ready) — mark clearly as future path.

\- Developer velocity for K-02/03/08 iteration.



\*\*What must stay CPU-only (even in Colab):\*\* Core tracker logic, MOG2 params, assignment, all output columns — to guarantee near-identical results vs production gold. Use `opencv-python-headless`. Fix seeds. Document any tiny platform diffs.



\*\*Bottom line:\*\* T4 is a powerful \*sandbox accelerator\* for speed/reliability/scale, not because the algorithm needs GPU FLOPs today. Production stays pure local CPU.



\### 4. Prioritized First Experiments (Ranked)



1\. \*\*Baseline Reproduction + Parity Validation\*\* (do first)  

&#x20;  Port minimal faithful production logic → run on 3–5 diverse clips (incl. known K-02/K-03 cases) → download CSVs → automated diff gate vs gold. Validates entire pipeline and catches env diffs early.



2\. \*\*Occlusion / Merge / ID-Swap Handling (K-03 + K-02)\*\*  

&#x20;  Curated short clips with proximity events. Lightweight sweeps on MOG2 params (esp. shadows), contour merge distance/area, assignment cost, simple temporal consistency. Output: per-variant CSV + annotated snippets. Rank by reduced spurious ID swaps + continuity. Human visual review on merges.



3\. \*\*px/sec Normalization to Physical Units (K-08)\*\*  

&#x20;  Arena calibration (manual or simple) → velocity in mm/s or body-lengths/s. Validate on stationary/slow clips + sanity checks. Augment CSV columns.



\*\*Why this order:\*\* Toolchain trust → biggest practical blockers with classical heuristics → scientific utility.  

\*\*Avoid until human GT scoring protocol + hold-out set exists:\*\* DL defaults, complex stochastic methods, long un-checkpointed runs, claims of superiority without quantitative human comparison.



\### 5. Decision Matrix \& Risks (Summary)



\*\*Colab T4 Sandbox vs Local WSL venv:\*\*

\- Use \*\*Colab\*\* for grids, long/batch runs, thermal offload, rapid discovery on K-02/03/08, optional future DL tests.

\- Use \*\*Local\*\* for quick edits, final A/B on full gold set, production parity, dashboard work, raw sensitive videos (default location).

\- \*\*Rule:\*\* Colab = discovery accelerator. Local = single source of truth + gatekeeper. Every promising Colab artifact must pass local diff gate + full gold A/B before merge consideration.



\*\*Top Risks/Anti-Patterns (academic lab context):\*\*

\- Cloud dependency creep or silent prod replacement.

\- Uploading sensitive assay videos without redaction/ethics approval/dedicated account.

\- Missing manifests (video hash, script sha, params, seed) → irreproducible results.

\- Skipping human GT validation on occlusion/ID-swap claims.

\- Leaving sessions running or quota burnout.

\- Parity drift (GPU paths or different OpenCV builds).



Full list + mitigations in the saved SOP.



\### Official Links Only

\- GitHub (install, commands, examples, `/docs`): https://github.com/googlecolab/google-colab-cli

\- Introducing the Google Colab CLI (blog): https://developers.googleblog.com/introducing-the-google-colab-cli/

\- Colab FAQ (limits, GPUs, sessions): https://research.google.com/colaboratory/faq.html

\- Paid plans: https://colab.research.google.com/signup



\*\*Next immediate steps:\*\* Run the Quick Start today, implement `baseline\_repro.py` + `csv\_validator.py` (minimal port + manifest + gate), execute Experiment #1 on 2–3 clips, then review with your lab team.



This setup gives you \*\*rapid, honest, reproducible progress\*\* on the open issues while strictly preserving Flyt’s local CPU-first, deterministic, transparent principles. The saved SOP is your complete reference — update it as you learn.



Let me know if you want me to generate starter script skeletons (`baseline\_repro.py`, manifest emitter, or the validator) or refine anything in the SOP. Ready to iterate!

