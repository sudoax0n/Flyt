import cv2
import pandas as pd
import numpy as np
import math
import sys
import os
import json
import argparse

# --- Configuration ---
parser = argparse.ArgumentParser(description='Drosophila Fly Tracker')
parser.add_argument('--input', type=str, default=None, help='Path to input video file')
parser.add_argument('--output-video', type=str, default='output_tracked.mp4', help='Path for output tracked video')
parser.add_argument('--output-csv', type=str, default='fly_tracking_data.csv', help='Path for output CSV data')
parser.add_argument('--no-video', action='store_true', help='Disable video output')
parser.add_argument('--min-area', type=int, default=30, help='Minimum contour area in pixels')
parser.add_argument('--max-area', type=int, default=0, help='Maximum contour area in pixels (0 = no limit)')
parser.add_argument('--roi', type=str, default=None, help='ROI rectangle as x,y,w,h in pixels')
parser.add_argument('--proximity-threshold', type=float, default=60.0, help='Courtship bout proximity threshold (px)')
parser.add_argument('--bout-min-frames', type=int, default=90, help='Minimum consecutive frames for a courtship bout')
parser.add_argument('--output-events', type=str, default=None, help='Path for suspected events JSON output')
args = parser.parse_args()

if args.input:
    VIDEO_PATH = os.path.abspath(args.input)
else:
    VIDEO_PATH = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "assets", "fly_video.mp4"))

OUTPUT_VIDEO_PATH = args.output_video
OUTPUT_CSV_PATH = args.output_csv
ENABLE_VIDEO_OUTPUT = not args.no_video
MIN_AREA = args.min_area
MAX_AREA = args.max_area
PROXIMITY_THRESHOLD = args.proximity_threshold
BOUT_MIN_FRAMES = args.bout_min_frames
OUTPUT_EVENTS_PATH = args.output_events
LOW_CONFIDENCE_THRESHOLD = 0.2
LOW_CONFIDENCE_MIN_FRAMES = 30

ROI_RECT = None
if args.roi:
    try:
        roi_parts = [int(v) for v in args.roi.split(',')]
        if len(roi_parts) != 4:
            raise ValueError
        ROI_RECT = tuple(roi_parts)
    except ValueError:
        print(f"Error: --roi must be x,y,w,h (got {args.roi!r})")
        sys.exit(1)


def contour_area_valid(area: float) -> bool:
    if area <= MIN_AREA:
        return False
    if MAX_AREA > 0 and area >= MAX_AREA:
        return False
    return True


def detect_sustained_segments(rows, condition_fn, min_frames: int):
    segments = []
    run_start = None

    for row in rows:
        frame = int(row["frame"])
        if condition_fn(row):
            if run_start is None:
                run_start = frame
        elif run_start is not None:
            run_end = frame - 1
            if run_end - run_start + 1 >= min_frames:
                segments.append((run_start, run_end))
            run_start = None

    if run_start is not None:
        run_end = int(rows[-1]["frame"])
        if run_end - run_start + 1 >= min_frames:
            segments.append((run_start, run_end))

    return segments


def segment_rows(rows, start_frame: int, end_frame: int):
    return [r for r in rows if start_frame <= int(r["frame"]) <= end_frame]


def build_event_record(
    event_id: str,
    event_type: str,
    start_frame: int,
    end_frame: int,
    fps: float,
    segment,
    detection_reason: str,
) -> dict:
    effective_fps = fps if fps > 0 else 30.0
    duration_frames = end_frame - start_frame + 1
    proximities = [float(r.get("proximity_distance") or 0) for r in segment]
    confidences = [float(r.get("identity_confidence") or 0) for r in segment]
    occlusions = [int(r.get("occlusion_flag") or 0) for r in segment]

    return {
        "id": event_id,
        "type": event_type,
        "start_frame": start_frame,
        "end_frame": end_frame,
        "start_time_sec": round(start_frame / effective_fps, 3),
        "end_time_sec": round(end_frame / effective_fps, 3),
        "duration_sec": round(duration_frames / effective_fps, 3),
        "mean_proximity_px": round(float(np.mean(proximities)), 2) if proximities else 0.0,
        "min_identity_confidence": round(float(min(confidences)), 4) if confidences else 0.0,
        "occlusion_fraction": round(float(np.mean(occlusions)), 4) if occlusions else 0.0,
        "detection_reason": detection_reason,
    }


def detect_events(rows, fps: float):
    events = []
    event_counter = 1

    courtship_segments = detect_sustained_segments(
        rows,
        lambda r: float(r.get("proximity_distance") or 999) < PROXIMITY_THRESHOLD,
        BOUT_MIN_FRAMES,
    )
    for start_frame, end_frame in courtship_segments:
        segment = segment_rows(rows, start_frame, end_frame)
        events.append(
            build_event_record(
                f"evt-{event_counter:03d}",
                "courtship_bout",
                start_frame,
                end_frame,
                fps,
                segment,
                "proximity_sustained",
            )
        )
        event_counter += 1

    low_conf_segments = detect_sustained_segments(
        rows,
        lambda r: float(r.get("identity_confidence") or 1) < LOW_CONFIDENCE_THRESHOLD,
        LOW_CONFIDENCE_MIN_FRAMES,
    )
    for start_frame, end_frame in low_conf_segments:
        segment = segment_rows(rows, start_frame, end_frame)
        events.append(
            build_event_record(
                f"evt-{event_counter:03d}",
                "low_confidence_segment",
                start_frame,
                end_frame,
                fps,
                segment,
                "identity_confidence_low",
            )
        )
        event_counter += 1

    events.sort(key=lambda e: e["start_frame"])
    return events


def write_events_json(rows, fps: float, output_path: str) -> None:
    effective_fps = fps if fps > 0 else 30.0
    events = detect_events(rows, effective_fps)
    envelope = {
        "version": 1,
        "fps": round(effective_fps, 3),
        "total_frames": len(rows),
        "detection_params": {
            "proximity_threshold_px": PROXIMITY_THRESHOLD,
            "bout_min_frames": BOUT_MIN_FRAMES,
            "low_confidence_threshold": LOW_CONFIDENCE_THRESHOLD,
            "low_confidence_min_frames": LOW_CONFIDENCE_MIN_FRAMES,
        },
        "events": events,
    }
    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(envelope, f, indent=2)
    print(f"Events saved to {output_path} ({len(events)} suspected events)")


def assignment_confidence(cA, cB, prev_f1, prev_f2) -> float:
    """Confidence from how clearly nearest-neighbor assignment beats the swap."""
    direct = float(math.dist(cA, prev_f1) + math.dist(cB, prev_f2))
    swapped = float(math.dist(cA, prev_f2) + math.dist(cB, prev_f1))
    margin = abs(swapped - direct)
    return float(np.clip(margin / (max(direct, swapped) + 1e-6), 0.2, 1.0))


if not os.path.exists(VIDEO_PATH):
    print(f"Error: Video file not found at {VIDEO_PATH}")
    sys.exit(1)

cap = cv2.VideoCapture(VIDEO_PATH)

width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
fps = cap.get(cv2.CAP_PROP_FPS)
expected_frame_count = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))

# Effective FPS for temporal normalization. Existing fly1_speed/fly2_speed stay
# in px/frame (byte-identical to pitch gold); px/sec is exposed via separate
# *_pxsec columns so pitch parity (Rule #2) is preserved.
effective_fps = fps if fps and fps > 0 else 30.0

if ENABLE_VIDEO_OUTPUT:
    fourcc = cv2.VideoWriter_fourcc(*'mp4v')  # type: ignore
    out = cv2.VideoWriter(OUTPUT_VIDEO_PATH, fourcc, fps, (width, height))

fgbg = cv2.createBackgroundSubtractorMOG2(history=500, varThreshold=50, detectShadows=False)

data = []
frame_num = 0
is_initialized = False
prev_f1 = (0, 0)
prev_f2 = (0, 0)

print(f"Starting tracking on {VIDEO_PATH}...")
if ROI_RECT:
    print(f"ROI active: x={ROI_RECT[0]}, y={ROI_RECT[1]}, w={ROI_RECT[2]}, h={ROI_RECT[3]}")
print(f"Contour area filter: {MIN_AREA} < area" + (f" < {MAX_AREA}" if MAX_AREA > 0 else ""))

while cap.isOpened():
    ret, frame = cap.read()
    if not ret:
        break

    fgmask = fgbg.apply(frame)
    kernel = np.ones((5, 5), np.uint8)
    fgmask = cv2.morphologyEx(fgmask, cv2.MORPH_OPEN, kernel)
    fgmask = cv2.morphologyEx(fgmask, cv2.MORPH_CLOSE, kernel)

    if ROI_RECT:
        rx, ry, rw, rh = ROI_RECT
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
            # Core pitch columns: displacement per frame in px/frame (0-diff parity).
            f1_speed = float(math.dist(f1_coords, prev_f1))
            f2_speed = float(math.dist(f2_coords, prev_f2))
            # Flyt temporal-normalized columns: physical speed in px/sec.
            f1_speed_pxsec = f1_speed * effective_fps
            f2_speed_pxsec = f2_speed * effective_fps

        proximity = float(math.dist(f1_coords, f2_coords))
        prev_f1 = f1_coords
        prev_f2 = f2_coords

        if ENABLE_VIDEO_OUTPUT:
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

        if ENABLE_VIDEO_OUTPUT:
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
        "frame": frame_num,
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

    if ENABLE_VIDEO_OUTPUT:
        out.write(frame)

    frame_num += 1

    if frame_num % 100 == 0:
        print(f"Processed {frame_num} frames...")

cap.release()
if ENABLE_VIDEO_OUTPUT:
    out.release()
cv2.destroyAllWindows()

df = pd.DataFrame(data)
df.to_csv(OUTPUT_CSV_PATH, index=False)

if OUTPUT_EVENTS_PATH:
    write_events_json(data, fps, OUTPUT_EVENTS_PATH)

csv_rows = len(data)
frames_processed = frame_num
last_frame_idx = data[-1]["frame"] if data else -1
sync_ok = (
    csv_rows == frames_processed
    and (frames_processed == 0 or last_frame_idx == frames_processed - 1)
)
print(
    f"TRACKER_SYNC frames_processed={frames_processed} csv_rows={csv_rows} "
    f"expected_video_frames={expected_frame_count} sync_ok={sync_ok}"
)
if not sync_ok:
    print("Warning: internal frame/CSV sync mismatch detected", file=sys.stderr)
    sys.exit(2)

print(f"Tracking completed! Data saved to {OUTPUT_CSV_PATH}.")