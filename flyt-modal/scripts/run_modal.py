import os
import sys
import zipfile
import io
import time
import argparse
import cv2
import modal

# Define the Modal App name
app = modal.App("flyt-tracker")

# Define the container image with all system dependencies and Python packages
flyt_image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install(["libgl1-mesa-glx", "libglib2.0-0", "ffmpeg"])
    .pip_install([
        "opencv-python-headless>=4.10.0",
        "pandas>=2.0.0",
        "numpy<2.0.0"
    ])
)

# ----------------- Remote tracking function on Modal -----------------
@app.function(
    image=flyt_image,
    cpu=4.0,
    memory=8192,
    timeout=600
)
def run_tracking_remote(zip_bytes: bytes, options: dict) -> dict:
    import cv2
    import numpy as np
    import pandas as pd
    import math
    import json
    import shutil
    import subprocess

    print("Extracting frames on remote worker...")
    frames_dir = "/tmp/frames"
    if os.path.exists(frames_dir):
        shutil.rmtree(frames_dir)
    os.makedirs(frames_dir)

    with zipfile.ZipFile(io.BytesIO(zip_bytes)) as zf:
        zf.extractall(frames_dir)

    frame_files = sorted([f for f in os.listdir(frames_dir) if f.endswith(".png")])
    total_frames = len(frame_files)
    print(f"Extracted {total_frames} frames successfully.")

    if total_frames == 0:
        return {"error": "No frames found in uploaded zip."}

    # Retrieve parameters
    min_area = options.get("min_area", 30)
    max_area = options.get("max_area", 0)
    proximity_threshold = options.get("proximity_threshold", 60.0)
    bout_min_frames = options.get("bout_min_frames", 90)
    fps = options.get("fps", 30.0)
    write_video = options.get("write_video", False)
    roi = options.get("roi", None)

    # Effective FPS for temporal-normalized speed columns. Core *_speed columns
    # stay in px/frame (parity-identical to the pitch baseline); *_speed_pxsec
    # expose physical speed in px/sec without touching the parity-tracked columns.
    effective_fps = fps if fps and fps > 0 else 30.0

    # Parse ROI
    roi_rect = None
    if roi:
        try:
            roi_parts = [int(v) for v in roi.split(',')]
            if len(roi_parts) == 4:
                roi_rect = tuple(roi_parts)
        except Exception as e:
            print(f"Warning: ROI parse failed: {e}")

    # Read first frame to get dimensions
    first_frame_path = os.path.join(frames_dir, frame_files[0])
    first_frame = cv2.imread(first_frame_path)
    height, width, _ = first_frame.shape

    # Video Writer
    raw_video_path = "/tmp/tracked_raw.mp4"
    out = None
    if write_video:
        fourcc = cv2.VideoWriter_fourcc(*'mp4v')
        out = cv2.VideoWriter(raw_video_path, fourcc, fps, (width, height))

    # Initialize CV components
    fgbg = cv2.createBackgroundSubtractorMOG2(history=500, varThreshold=50, detectShadows=False)
    
    data = []
    prev_f1 = (0, 0)
    prev_f2 = (0, 0)
    is_initialized = False

    def contour_area_valid(area: float) -> bool:
        if area <= min_area:
            return False
        if max_area > 0 and area >= max_area:
            return False
        return True

    def assignment_confidence(cA, cB, pf1, pf2) -> float:
        direct = float(math.dist(cA, pf1) + math.dist(cB, pf2))
        swapped = float(math.dist(cA, pf2) + math.dist(cB, pf1))
        margin = abs(swapped - direct)
        return float(np.clip(margin / (max(direct, swapped) + 1e-6), 0.2, 1.0))

    print("Starting tracking loop...")
    for frame_idx, frame_file in enumerate(frame_files):
        frame_path = os.path.join(frames_dir, frame_file)
        frame = cv2.imread(frame_path)

        fgmask = fgbg.apply(frame)
        kernel = np.ones((5, 5), np.uint8)
        fgmask = cv2.morphologyEx(fgmask, cv2.MORPH_OPEN, kernel)
        fgmask = cv2.morphologyEx(fgmask, cv2.MORPH_CLOSE, kernel)

        if roi_rect:
            rx, ry, rw, rh = roi_rect
            roi_mask = np.zeros_like(fgmask)
            roi_mask[ry:ry + rh, rx:rx + rw] = 255
            fgmask = cv2.bitwise_and(fgmask, roi_mask)

        activity_level = int(cv2.countNonZero(fgmask))

        contours, _ = cv2.findContours(fgmask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        valid_contours = [cnt for cnt in contours if contour_area_valid(cv2.contourArea(cnt))]
        valid_contours.sort(key=cv2.contourArea, reverse=True)

        current_centroids = []
        bboxes = []
        contour_areas = []

        max_idx = min(2, len(valid_contours))
        for i in range(max_idx):
            cnt = valid_contours[i]
            x, y, w, h = cv2.boundingRect(cnt)
            cx = int(x + w / 2)
            cy = int(y + h / 2)
            current_centroids.append((cx, cy))
            bboxes.append((x, y, w, h))
            contour_areas.append(float(cv2.contourArea(cnt)))

        f1_coords = (0, 0)
        f2_coords = (0, 0)
        f1_speed = 0.0
        f2_speed = 0.0
        f1_speed_pxsec = 0.0
        f2_speed_pxsec = 0.0
        proximity = 0.0
        occlusion_flag = 0
        identity_conf = 0.0
        fly1_area = 0.0
        fly2_area = 0.0

        if len(current_centroids) == 2:
            cA, cB = current_centroids[0], current_centroids[1]

            if not is_initialized:
                f1, f2 = cA, cB
                is_initialized = True
                identity_conf = 0.5
            else:
                dist_A_to_prev1 = float(math.dist(cA, prev_f1))
                dist_A_to_prev2 = float(math.dist(cA, prev_f2))
                dist_B_to_prev1 = float(math.dist(cB, prev_f1))
                dist_B_to_prev2 = float(math.dist(cB, prev_f2))

                if dist_A_to_prev1 + dist_B_to_prev2 < dist_A_to_prev2 + dist_B_to_prev1:
                    f1, f2 = cA, cB
                else:
                    f1, f2 = cB, cA

                identity_conf = assignment_confidence(cA, cB, prev_f1, prev_f2)

            f1_coords = f1
            f2_coords = f2
            if f1 == cA:
                fly1_area = contour_areas[0]
                fly2_area = contour_areas[1]
            else:
                fly1_area = contour_areas[1]
                fly2_area = contour_areas[0]

            if is_initialized:
                # Core pitch columns: px/frame (0-diff parity with baseline).
                f1_speed = float(math.dist(f1_coords, prev_f1))
                f2_speed = float(math.dist(f2_coords, prev_f2))
                # Temporal-normalized columns: physical speed in px/sec.
                f1_speed_pxsec = f1_speed * effective_fps
                f2_speed_pxsec = f2_speed * effective_fps

            proximity = float(math.dist(f1_coords, f2_coords))
            prev_f1 = f1_coords
            prev_f2 = f2_coords

            if write_video and out:
                for (x, y, w, h) in bboxes:
                    cv2.rectangle(frame, (x, y), (x + w, y + h), (0, 255, 0), 2)
                cv2.circle(frame, f1_coords, 5, (255, 0, 0), -1)
                cv2.circle(frame, f2_coords, 5, (0, 0, 255), -1)
                cv2.line(frame, f1_coords, f2_coords, (0, 255, 255), 2)
                text_pos = (min(f1_coords[0], f2_coords[0]), max(0, min(f1_coords[1], f2_coords[1]) - 10))
                cv2.putText(frame, f"Dist: {int(proximity)}px", text_pos, cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 255, 255), 2)

        elif len(current_centroids) == 1:
            cA = current_centroids[0]
            f1_coords = cA
            f2_coords = cA
            occlusion_flag = 1
            identity_conf = 0.25
            fly1_area = contour_areas[0]
            fly2_area = contour_areas[0]

            if is_initialized:
                # Core pitch columns (px/frame, parity-identical to pitch on merge frames).
                f1_speed = float(math.dist(f1_coords, prev_f1))
                f2_speed = float(math.dist(f2_coords, prev_f2))
                f1_speed_pxsec = f1_speed * effective_fps
                f2_speed_pxsec = f2_speed * effective_fps

            proximity = 0.0
            prev_f1 = f1_coords
            prev_f2 = f2_coords
            is_initialized = True

            if write_video and out:
                x, y, w, h = bboxes[0]
                cv2.rectangle(frame, (x, y), (x + w, y + h), (0, 255, 255), 3)
                cv2.putText(frame, "MERGED", (x, max(0, y - 10)), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 255, 255), 2)

        else:
            if is_initialized:
                f1_coords = prev_f1
                f2_coords = prev_f2
                proximity = float(math.dist(f1_coords, f2_coords))
                identity_conf = 0.15

        data.append({
            "frame": frame_idx,
            "fly1_x": f1_coords[0],
            "fly1_y": f1_coords[1],
            "fly2_x": f2_coords[0],
            "fly2_y": f2_coords[1],
            "fly1_speed": f1_speed,
            "fly2_speed": f2_speed,
            "fly1_speed_pxsec": round(f1_speed_pxsec, 4),
            "fly2_speed_pxsec": round(f2_speed_pxsec, 4),
            "activity_level": activity_level,
            "proximity_distance": proximity,
            "occlusion_flag": occlusion_flag,
            "identity_confidence": round(identity_conf, 4),
            "fly1_area": fly1_area,
            "fly2_area": fly2_area,
        })

        if write_video and out:
            out.write(frame)

        if (frame_idx + 1) % 100 == 0:
            print(f"Remote processed {frame_idx + 1}/{total_frames} frames...")

    if out:
        out.release()
    cv2.destroyAllWindows()

    # Create CSV string
    df = pd.DataFrame(data)
    csv_string = df.to_csv(index=False)

    # Event detection logic
    low_confidence_threshold = 0.2
    low_confidence_min_frames = 30
    
    def detect_sustained_segments(rows, condition_fn, min_frames: int):
        segments = []
        run_start = None
        for r in rows:
            f = int(r["frame"])
            if condition_fn(r):
                if run_start is None:
                    run_start = f
            elif run_start is not None:
                run_end = f - 1
                if run_end - run_start + 1 >= min_frames:
                    segments.append((run_start, run_end))
                run_start = None
        if run_start is not None:
            run_end = int(rows[-1]["frame"])
            if run_end - run_start + 1 >= min_frames:
                segments.append((run_start, run_end))
        return segments

    def segment_rows(rows, start_f: int, end_f: int):
        return [r for r in rows if start_f <= int(r["frame"]) <= end_f]

    def build_event_record(evt_id, evt_type, start_f, end_f, segment, reason):
        duration_frames = end_f - start_f + 1
        proximities = [float(r.get("proximity_distance") or 0) for r in segment]
        confidences = [float(r.get("identity_confidence") or 0) for r in segment]
        occlusions = [int(r.get("occlusion_flag") or 0) for r in segment]
        return {
            "id": evt_id,
            "type": evt_type,
            "start_frame": start_f,
            "end_frame": end_f,
            "start_time_sec": round(start_f / fps, 3),
            "end_time_sec": round(end_f / fps, 3),
            "duration_sec": round(duration_frames / fps, 3),
            "mean_proximity_px": round(float(np.mean(proximities)), 2) if proximities else 0.0,
            "min_identity_confidence": round(float(min(confidences)), 4) if confidences else 0.0,
            "occlusion_fraction": round(float(np.mean(occlusions)), 4) if occlusions else 0.0,
            "detection_reason": reason,
        }

    events = []
    event_counter = 1
    
    courtship_segments = detect_sustained_segments(
        data,
        lambda r: float(r.get("proximity_distance") or 999) < proximity_threshold,
        bout_min_frames
    )
    for s_f, e_f in courtship_segments:
        seg = segment_rows(data, s_f, e_f)
        events.append(build_event_record(f"evt-{event_counter:03d}", "courtship_bout", s_f, e_f, seg, "proximity_sustained"))
        event_counter += 1

    low_conf_segments = detect_sustained_segments(
        data,
        lambda r: float(r.get("identity_confidence") or 1) < low_confidence_threshold,
        low_confidence_min_frames
    )
    for s_f, e_f in low_conf_segments:
        seg = segment_rows(data, s_f, e_f)
        events.append(build_event_record(f"evt-{event_counter:03d}", "low_confidence_segment", s_f, e_f, seg, "identity_confidence_low"))
        event_counter += 1

    events.sort(key=lambda e: e["start_frame"])

    events_envelope = {
        "version": 1,
        "fps": round(fps, 3),
        "total_frames": len(data),
        "detection_params": {
            "proximity_threshold_px": proximity_threshold,
            "bout_min_frames": bout_min_frames,
            "low_confidence_threshold": low_confidence_threshold,
            "low_confidence_min_frames": low_confidence_min_frames,
        },
        "events": events,
    }
    events_string = json.dumps(events_envelope, indent=2)

    # Transcode video to H.264
    video_bytes = b""
    if write_video and os.path.exists(raw_video_path):
        transcoded_path = "/tmp/tracked.mp4"
        print("Transcoding annotated video to H.264...")
        transcode_cmd = [
            "ffmpeg", "-i", raw_video_path,
            "-vcodec", "libx264", "-acodec", "aac",
            "-pix_fmt", "yuv420p", "-y", transcoded_path
        ]
        res = subprocess.run(transcode_cmd, capture_output=True)
        if res.returncode == 0 and os.path.exists(transcoded_path):
            with open(transcoded_path, "rb") as vf:
                video_bytes = vf.read()
            print("Video transcode completed successfully.")
        else:
            print(f"Video transcode failed: {res.stderr.decode()}")
            with open(raw_video_path, "rb") as vf:
                video_bytes = vf.read()

    return {
        "csv": csv_string,
        "events": events_string,
        "video": video_bytes,
        "frames_processed": total_frames
    }

# ----------------- Local execution entrypoint -----------------
@app.local_entrypoint()
def main(video_path: str, output_csv: str = "results/modal_parity_test.csv", output_events: str = "results/events.json", output_video: str = "results/tracked.mp4", write_video: bool = False):
    if not os.path.exists(video_path):
        print(f"Error: Local video file not found at: {video_path}", flush=True)
        sys.exit(1)

    print(f"Local: Opening video {video_path} to dump frames...", flush=True)
    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        print(f"Error: Could not open video file.", flush=True)
        sys.exit(1)

    fps = cap.get(cv2.CAP_PROP_FPS)
    if fps <= 0:
        fps = 30.0

    # Write frames to zip in memory
    zip_buffer = io.BytesIO()
    with zipfile.ZipFile(zip_buffer, 'w', zipfile.ZIP_STORED) as zf:
        frame_num = 0
        t0 = time.time()
        while True:
            ret, frame = cap.read()
            if not ret:
                break
            # Lossless PNG encoding of the frame with fastest compression (1)
            _, buf = cv2.imencode('.png', frame, [cv2.IMWRITE_PNG_COMPRESSION, 1])
            zf.writestr(f"frame_{frame_num:04d}.png", buf.tobytes())
            frame_num += 1
            if frame_num % 200 == 0:
                print(f"Local: Zipped {frame_num} frames...", flush=True)
        
    cap.release()
    zip_bytes = zip_buffer.getvalue()
    zip_size_mb = len(zip_bytes) / (1024 * 1024)
    print(f"Local: Zipped {frame_num} frames ({zip_size_mb:.2f} MB) in {time.time() - t0:.2f}s.", flush=True)

    # Execute on Modal remote container
    print("Local: Spawning Modal serverless container...", flush=True)
    t_start = time.time()
    
    options = {
        "min_area": 30,
        "max_area": 0,
        "proximity_threshold": 60.0,
        "bout_min_frames": 90,
        "fps": fps,
        "write_video": write_video,
    }
    
    results = run_tracking_remote.remote(zip_bytes, options)
    
    if "error" in results:
        print(f"Remote error: {results['error']}", flush=True)
        sys.exit(1)
        
    print(f"Local: Modal tracking finished in {time.time() - t_start:.2f}s.", flush=True)

    # Save CSV
    os.makedirs(os.path.dirname(output_csv), exist_ok=True)
    with open(output_csv, "w", encoding="utf-8") as f:
        f.write(results["csv"])
    print(f"Local: Saved CSV to {output_csv}", flush=True)

    # Save Events JSON
    if output_events:
        os.makedirs(os.path.dirname(output_events), exist_ok=True)
        with open(output_events, "w", encoding="utf-8") as f:
            f.write(results["events"])
        print(f"Local: Saved events to {output_events}", flush=True)

    # Save Video
    if write_video and results.get("video"):
        os.makedirs(os.path.dirname(output_video), exist_ok=True)
        with open(output_video, "wb") as f:
            f.write(results["video"])
        print(f"Local: Saved tracked video to {output_video}", flush=True)

