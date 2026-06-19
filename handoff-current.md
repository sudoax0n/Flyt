# Flyt — Master Handoff & Roadmap

**Last updated:** 2026-06-17  
**Working copy:** `E:\Flyt`  
**Gold reference (read-only):** `E:\prasad-pitch` — **never edit**

Please copy the Starter Prompt at the bottom of this document to initiate the next agent session (`z-code`).

---

## 1. Context & Task Status

We are working on **Flyt**, a local CPU-first behavioral tracking dashboard for Drosophila assays. 

### B. The Parity & Decoding Drift Dilemma
To run remote experiments or batch sweeps in the cloud (Linux) that match our local Windows reference (`E:\prasad-pitch/source app folder/tracker/fly_tracking_data.csv`), the tracking outputs must achieve spatiotemporal validation parity (**RMSE < 2.0 px**).
- **The Issue:** Windows decodes compressed video (`fly_video.mp4`) via Microsoft Media Foundation (MSMF), while Linux decodes it via FFmpeg. This introduces a subtle 1-2px decoding drift in decoded pixel values. The `MOG2` background subtractor accumulates this drift, leading to a missed contour at frame 117 on Linux, which triggers an identity swap not present in the Windows gold output.
- **The Solution:** We have completely deleted the Colab WSL/Ubuntu sandbox to free up C: drive space, and migrated to a **Windows-native Modal integration** (`e:\Flyt\flyt-modal`).
- **How Parity is Achieved Natively:** We created a Windows-native Python script `flyt-modal/scripts/run_modal.py`. It opens `fly_video.mp4` locally using the Windows MSMF video decoder, encodes the frames to lossless PNGs, and zips them directly in-memory (to avoid temporary disk usage). It then uploads the zip to Modal. Because PNG has a single lossless decoding standard, both platforms see the exact same pixels, guaranteeing 0-diff parity without snapping hacks!

---

## 2. Active Roadmap for `z-code`

The user wants `z-code` to implement and fix the five major local technical debt items:

### 🛠️ Task A: Connect Settings UI to Backend (K-04)
- **Files to Edit:** 
  - [App.jsx](file:///E:/Flyt/source%20app%20folder/dashboard/src/App.jsx)
  - [server.js](file:///E:/Flyt/source%20app%20folder/dashboard/server.js)
- **React UI Updates:**
  - Create a parent settings state in `App.jsx` holding active configuration defaults:
    `const [settings, setSettings] = useState({ minArea: 30, maxArea: 0, proximityThreshold: 60, boutMinFrames: 90 })`.
  - Bind these variables to the inputs in `SettingsModal`, and call a handler to update the parent state when "Apply Configuration" is clicked.
  - In `handleFileSelect`, append these values to the `FormData` body (e.g., `formData.append('minArea', settings.minArea)`) before initiating the `POST /api/upload` request.
- **Express Backend Updates:**
  - Parse parameters from `req.body` in `POST /api/upload`.
  - Pass the parameters as CLI args when spawning `tracker.py` (e.g., `--min-area`, `--max-area`, `--proximity-threshold`, `--bout-min-frames`).

### 🛠️ Task B: Normalize Speed to pixels/second (K-08)
- **Files to Edit:** 
  - [tracker.py](file:///E:/Flyt/source%20app%20folder/tracker/tracker.py)
- **Mathematical Adjustment:**
  - Standardize velocity to represent physical/temporal speed (`pixels/second`) rather than frame-level displacement.
  - In the tracking loops, read the actual video FPS and multiply Euclidean displacement:
    ```python
    effective_fps = fps if fps > 0 else 30.0
    fly1_speed = float(math.dist(fly1_coords, prev_fly1)) * effective_fps
    fly2_speed = float(math.dist(fly2_coords, prev_fly2)) * effective_fps
    ```

### 🛠️ Task C: Platform-Agnostic venv Detection (K-12)
- **Files to Edit:** 
  - [server.js](file:///E:/Flyt/source%20app%20folder/dashboard/server.js)
- **Logic Change:**
  - Replace the hardcoded Windows path `tracker/venv/Scripts/python.exe` with dynamic platform checking to support execution on Mac/Linux:
    ```javascript
    const isWindows = process.platform === 'win32';
    const pythonExe = path.join(trackerDir, 'venv', isWindows ? 'Scripts' : 'bin', isWindows ? 'python.exe' : 'python');
    ```

### 🛠️ Task D: Export Buttons (GraphPad Prism & PDF) (K-07)
- **Files to Edit:** 
  - [App.jsx](file:///E:/Flyt/source%20app%20folder/dashboard/src/App.jsx) (DashboardView)
- **Prism CSV Formatting:**
  - Implement a client-side exporter function for the "Download CSV (Prism)" button.
  - Convert/pivot the rows of coordinates into a column-oriented schema: `Time (sec)`, `Fly1_Velocity`, `Fly2_Velocity`, `Distance (proximity)`.
- **Report Generation:**
  - Connect the "Export PDF Report" button to trigger `window.print()`.
  - Update `index.css` or inject inline CSS with `@media print` rules to optimize the layout: hide navigation elements, sidebar, and print-unfriendly buttons, showing only clean Recharts graphs and metrics cards formatted for paper/PDF.

### 🛠️ Task E: Local Run History Persistence (K-06)
- **Files to Edit:**
  - [server.js](file:///E:/Flyt/source%20app%20folder/dashboard/server.js)
  - [App.jsx](file:///E:/Flyt/source%20app%20folder/dashboard/src/App.jsx)
- **Persistence Layer:**
  - Initialize a local JSON store file (`public/history.json` or similar) on the Express backend.
  - On every successful tracking run, append run metadata: `runId`, `timestamp`, `filename`, `duration`, `avgProximity`, `detectedBouts`, `verifiedBouts`.
- **Frontend Integration:**
  - Fetch history data from the server on mount.
  - Render the runs list dynamically under the "History" tab, replacing the mock rows.
  - Allow the user to click a run to reload its tracking dataset (`data.csv` / `events.json`) directly into the active dashboard view.

---

## 3. Permanent Development Rules

1. **Never edit `E:\prasad-pitch`:** Read-only gold source.
2. **Pitch tracker core is production default:** Local modifications to `tracker.py` must maintain **0 diffs** on core columns for `fly_video.mp4` compared to pitch baseline output unless specifically approved.
3. **Ego-Free Deep Research:** Never guess biological indices, sleep metrics, or complex CV math. Draft a Google Deep Research prompt for the user if unsure, and pause.
4. **Colab is deprecated:** The Google Colab CLI sandbox has been removed and unregistered to save disk space. The cloud environment is now natively driven by **Modal** in the `flyt-modal/` folder.

---

## 4. Starter Prompt for `z-code`

```
Read E:\Flyt\handoff-current.md, AGENTS.md, and improvements.md before coding.

Tasks to implement/fix:
1. Run flyt-modal/AUTH-MODAL.bat to authenticate your native Windows environment with Modal.
2. Run flyt-modal/RUN-MODAL-PARITY.bat to run the serverless tracking engine on Modal and verify RMSE < 2.0 px parity.
3. Connect Settings UI to Backend CLI args (Task A / K-04).
4. Normalize speed metrics to pixels/second using video FPS (Task B / K-08).
5. Implement platform-agnostic python executable detection (Task C / K-12).
6. Wire up GraphPad Prism CSV exporter and PDF print formatting (Task D / K-07).
7. Build local run history persistence in backend + React frontend (Task E / K-06).

Permanent rules:
- Never edit E:\prasad-pitch
- No ToxId/scipy changes in production unless requested with A/B proof.
- Start production server: cd "source app folder/dashboard" && npm run dev (or double-click START.bat).
```