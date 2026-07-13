import argparse
import json
import math
import os
import sys
from typing import Any, Callable

import cv2
import numpy as np
import pandas as pd

LOW_CONFIDENCE_THRESHOLD = 0.2
LOW_CONFIDENCE_MIN_FRAMES = 30
COURTSHIP_MIN_IDENTITY_CONFIDENCE = 0.2


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Drosophila Fly Tracker")
    parser.add_argument("--input", type=str, default=None)
    parser.add_argument("--output-video", type=str, default="output_tracked.mp4")
    parser.add_argument("--output-csv", type=str, default="fly_tracking_data.csv")
    parser.add_argument("--no-video", action="store_true")
    parser.add_argument("--min-area", type=int, default=30)
    parser.add_argument("--max-area", type=int, default=0)
    parser.add_argument("--roi", type=str, default=None)
    parser.add_argument("--proximity-threshold", type=float, default=60.0)
    parser.add_argument("--bout-min-frames", type=int, default=90)
    parser.add_argument("--output-events", type=str, default=None)
    return parser.parse_args(argv)


def value_or(row: dict[str, Any], key: str, default: float) -> float:
    value = row.get(key)
    if value is None or value == "":
        return default
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def detect_sustained_segments(
    rows: list[dict[str, Any]],
    condition_fn: Callable[[dict[str, Any]], bool],
    min_frames: int,
) -> list[tuple[int, int]]:
    segments: list[tuple[int, int]] = []
    run_start: int | None = None
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
    if run_start is not None and rows:
        run_end = int(rows[-1]["frame"])
        if run_end - run_start + 1 >= min_frames:
            segments.append((run_start, run_end))
    return segments


def build_event_record(
    event_id: str,
    event_type: str,
    start_frame: int,
    end_frame: int,
    fps: float,
    segment: list[dict[str, Any]],
    detection_reason: str,
) -> dict[str, Any]:
    effective_fps = fps if fps > 0 else 30.0
    duration_frames = end_frame - start_frame + 1
    proximities = [
        value_or(row, "proximity_distance", math.nan) for row in segment
        if math.isfinite(value_or(row, "proximity_distance", math.nan))
    ]
    confidences = [value_or(row, "identity_confidence", 0.0) for row in segment]
    occlusions = [value_or(row, "occlusion_flag", 0.0) for row in segment]
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


def is_courtship_frame(row: dict[str, Any], proximity_threshold: float) -> bool:
    proximity = value_or(row, "proximity_distance", math.inf)
    confidence = value_or(row, "identity_confidence", 0.0)
    occluded = value_or(row, "occlusion_flag", 1.0) != 0.0
    fly1_present = value_or(row, "fly1_area", 0.0) > 0.0
    fly2_present = value_or(row, "fly2_area", 0.0) > 0.0
    tracking_valid = value_or(row, "tracking_valid", 1.0) != 0.0
    return (
        tracking_valid
        and math.isfinite(proximity)
        and not occluded
        and fly1_present
        and fly2_present
        and confidence >= COURTSHIP_MIN_IDENTITY_CONFIDENCE
        and proximity < proximity_threshold
    )


def is_low_confidence_frame(row: dict[str, Any]) -> bool:
    return (
        value_or(row, "tracking_valid", 1.0) == 0.0
        or value_or(row, "occlusion_flag", 0.0) != 0.0
        or value_or(row, "identity_confidence", 1.0) < LOW_CONFIDENCE_THRESHOLD
    )


def detect_events(
    rows: list[dict[str, Any]],
    fps: float,
    proximity_threshold: float,
    bout_min_frames: int,
) -> list[dict[str, Any]]:
    events: list[dict[str, Any]] = []
    counter = 1
    courtship = detect_sustained_segments(
        rows,
        lambda row: is_courtship_frame(row, proximity_threshold),
        max(1, bout_min_frames),
    )
    low_confidence = detect_sustained_segments(
        rows,
        is_low_confidence_frame,
        LOW_CONFIDENCE_MIN_FRAMES,
    )
    for event_type, segments, reason in (
        (
            "courtship_bout",
            courtship,
            "separate_flies_with_sustained_proximity_and_identity_confidence",
        ),
        ("low_confidence_segment", low_confidence, "identity_or_occlusion_uncertain"),
    ):
        for start, end in segments:
            segment = [row for row in rows if start <= int(row["frame"]) <= end]
            events.append(build_event_record(
                f"evt-{counter:03d}", event_type, start, end, fps, segment, reason,
            ))
            counter += 1
    events.sort(key=lambda event: event["start_frame"])
    return events


def write_events_json(
    rows: list[dict[str, Any]],
    fps: float,
    output_path: str,
    proximity_threshold: float,
    bout_min_frames: int,
) -> None:
    effective_fps = fps if fps > 0 else 30.0
    events = detect_events(rows, effective_fps, proximity_threshold, bout_min_frames)
    payload = {
        "version": 1,
        "fps": round(effective_fps, 3),
        "total_frames": len(rows),
        "detection_params": {
            "proximity_threshold_px": proximity_threshold,
            "bout_min_frames": max(1, bout_min_frames),
            "courtship_min_identity_confidence": COURTSHIP_MIN_IDENTITY_CONFIDENCE,
            "courtship_requires_separate_flies": True,
            "low_confidence_threshold": LOW_CONFIDENCE_THRESHOLD,
            "low_confidence_min_frames": LOW_CONFIDENCE_MIN_FRAMES,
        },
        "events": events,
    }
    with open(output_path, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, indent=2)
    print(f"Events saved to {output_path} ({len(events)} suspected events)")


def displacement(previous, current, was_initialized: bool) -> float:
    """Pitch-compatible frame displacement in px/frame.

    When tracking is not yet initialized, speed is 0 (no prior position to
    measure against). Callers that follow pitch/main set ``is_initialized``
    before computing speed on the first two-fly frame, so the first measured
    displacement is against the last held/merge position (or origin).
    """
    return float(math.dist(current, previous)) if was_initialized else 0.0


def assignment_confidence(ca, cb, prev_f1, prev_f2) -> float:
    direct = float(math.dist(ca, prev_f1) + math.dist(cb, prev_f2))
    swapped = float(math.dist(ca, prev_f2) + math.dist(cb, prev_f1))
    margin = abs(swapped - direct)
    return float(np.clip(margin / (max(direct, swapped) + 1e-6), 0.0, 1.0))


def frame_sync_ok(
    frames_processed: int,
    csv_rows: int,
    last_frame: int,
    expected_frame_count: int,
) -> bool:
    internal_sync_ok = (
        csv_rows == frames_processed
        and (frames_processed == 0 or last_frame == frames_processed - 1)
    )
    # OpenCV CAP_PROP_FRAME_COUNT is diagnostic only. The server performs the
    # authoritative full decode with ffmpeg and compares it to tracker/CSV/video output.
    _ = expected_frame_count
    return internal_sync_ok


def parse_roi(value: str | None) -> tuple[int, int, int, int] | None:
    if not value:
        return None
    try:
        parts = [int(item) for item in value.split(",")]
    except ValueError as error:
        raise ValueError(f"--roi must be x,y,w,h (got {value!r})") from error
    if len(parts) != 4:
        raise ValueError(f"--roi must be x,y,w,h (got {value!r})")
    return tuple(parts)  # type: ignore[return-value]


def run_tracker(args: argparse.Namespace) -> int:
    video_path = os.path.abspath(args.input) if args.input else os.path.abspath(
        os.path.join(os.path.dirname(__file__), "..", "..", "assets", "fly_video.mp4")
    )
    if not os.path.exists(video_path):
        print(f"Error: Video file not found at {video_path}")
        return 1
    try:
        roi_rect = parse_roi(args.roi)
    except ValueError as error:
        print(f"Error: {error}")
        return 1

    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        print(f"Error: Could not open video at {video_path}")
        return 1
    width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    fps = float(cap.get(cv2.CAP_PROP_FPS))
    effective_fps = fps if fps > 0 else 30.0
    expected_frame_count = max(0, int(cap.get(cv2.CAP_PROP_FRAME_COUNT)))

    out = None
    if not args.no_video:
        fourcc = cv2.VideoWriter_fourcc(*"mp4v")
        out = cv2.VideoWriter(args.output_video, fourcc, effective_fps, (width, height))
        if not out.isOpened():
            cap.release()
            print(f"Error: Could not create output video at {args.output_video}")
            return 1

    fgbg = cv2.createBackgroundSubtractorMOG2(
        history=500, varThreshold=50, detectShadows=False,
    )
    kernel = np.ones((5, 5), np.uint8)
    data: list[dict[str, Any]] = []
    frame_num = 0
    is_initialized = False
    prev_f1 = (0, 0)
    prev_f2 = (0, 0)

    print(f"Starting tracking on {video_path}...")
    if roi_rect:
        print(
            f"ROI active: x={roi_rect[0]}, y={roi_rect[1]}, "
            f"w={roi_rect[2]}, h={roi_rect[3]}"
        )

    try:
        while cap.isOpened():
            ret, frame = cap.read()
            if not ret:
                break
            fgmask = fgbg.apply(frame)
            fgmask = cv2.morphologyEx(fgmask, cv2.MORPH_OPEN, kernel)
            fgmask = cv2.morphologyEx(fgmask, cv2.MORPH_CLOSE, kernel)
            if roi_rect:
                rx, ry, rw, rh = roi_rect
                roi_mask = np.zeros_like(fgmask)
                roi_mask[ry:ry + rh, rx:rx + rw] = 255
                fgmask = cv2.bitwise_and(fgmask, roi_mask)

            activity_level = int(cv2.countNonZero(fgmask))
            contours, _ = cv2.findContours(
                fgmask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE,
            )
            valid = [
                contour for contour in contours
                if cv2.contourArea(contour) > args.min_area
                and (args.max_area <= 0 or cv2.contourArea(contour) < args.max_area)
            ]
            valid.sort(key=cv2.contourArea, reverse=True)
            centroids, bboxes, areas = [], [], []
            for contour in valid[:2]:
                x, y, w, h = cv2.boundingRect(contour)
                centroids.append((int(x + w / 2), int(y + h / 2)))
                bboxes.append((x, y, w, h))
                areas.append(float(cv2.contourArea(contour)))

            # Canonical core columns default like pitch/main (finite numbers).
            # tracking_valid / detection_count are additive Flyt metadata only.
            f1_coords = f2_coords = (0, 0)
            f1_speed = f2_speed = 0.0
            proximity = 0.0
            occlusion_flag = 0
            identity_confidence = 0.0
            fly1_area = fly2_area = 0.0
            detection_count = len(centroids)
            tracking_valid = 0

            if len(centroids) == 2:
                ca, cb = centroids
                if not is_initialized:
                    f1, f2 = ca, cb
                    is_initialized = True
                    identity_confidence = 0.5
                else:
                    direct = math.dist(ca, prev_f1) + math.dist(cb, prev_f2)
                    swapped = math.dist(ca, prev_f2) + math.dist(cb, prev_f1)
                    f1, f2 = (ca, cb) if direct < swapped else (cb, ca)
                    identity_confidence = assignment_confidence(ca, cb, prev_f1, prev_f2)
                f1_coords, f2_coords = f1, f2
                if f1 == ca:
                    fly1_area, fly2_area = areas[0], areas[1]
                else:
                    fly1_area, fly2_area = areas[1], areas[0]
                # Pitch/main: is_initialized is True here, so measure displacement
                # from previous held/merge/assigned position (may be origin on
                # first-ever two-fly frame with no prior detection).
                f1_speed = float(math.dist(f1_coords, prev_f1))
                f2_speed = float(math.dist(f2_coords, prev_f2))
                proximity = float(math.dist(f1_coords, f2_coords))
                tracking_valid = 1
                prev_f1, prev_f2 = f1_coords, f2_coords
                if out:
                    for x, y, w, h in bboxes:
                        cv2.rectangle(frame, (x, y), (x + w, y + h), (0, 255, 0), 2)
                    cv2.circle(frame, f1_coords, 5, (255, 0, 0), -1)
                    cv2.circle(frame, f2_coords, 5, (0, 0, 255), -1)
                    cv2.line(frame, f1_coords, f2_coords, (0, 255, 255), 2)
                    text_pos = (
                        min(f1_coords[0], f2_coords[0]),
                        max(0, min(f1_coords[1], f2_coords[1]) - 10),
                    )
                    cv2.putText(
                        frame,
                        f"Dist: {int(proximity)}px",
                        text_pos,
                        cv2.FONT_HERSHEY_SIMPLEX,
                        0.6,
                        (0, 255, 255),
                        2,
                    )
            elif len(centroids) == 1:
                # Pitch merge: both IDs share the merged centroid, proximity=0,
                # speeds from previous positions when already initialized.
                point = centroids[0]
                f1_coords = f2_coords = point
                occlusion_flag = 1
                identity_confidence = 0.0
                fly1_area = fly2_area = areas[0]
                if is_initialized:
                    f1_speed = float(math.dist(f1_coords, prev_f1))
                    f2_speed = float(math.dist(f2_coords, prev_f2))
                proximity = 0.0
                prev_f1 = prev_f2 = point
                is_initialized = True
                if out:
                    x, y, w, h = bboxes[0]
                    cv2.rectangle(frame, (x, y), (x + w, y + h), (0, 255, 255), 3)
                    cv2.putText(
                        frame,
                        "MERGED",
                        (x, max(0, y - 10)),
                        cv2.FONT_HERSHEY_SIMPLEX,
                        0.6,
                        (0, 255, 255),
                        2,
                    )
            elif is_initialized:
                # Pitch dropout: hold last coordinates; proximity is last-known
                # separation; speeds remain 0 (no measured displacement this frame).
                # tracking_valid stays 0 — consumers must consult metadata, not NaNs.
                f1_coords, f2_coords = prev_f1, prev_f2
                proximity = float(math.dist(f1_coords, f2_coords))
                identity_confidence = 0.0

            data.append({
                "frame": frame_num,
                "fly1_x": f1_coords[0],
                "fly1_y": f1_coords[1],
                "fly2_x": f2_coords[0],
                "fly2_y": f2_coords[1],
                "fly1_speed": f1_speed,
                "fly2_speed": f2_speed,
                "fly1_speed_pxsec": round(f1_speed * effective_fps, 4),
                "fly2_speed_pxsec": round(f2_speed * effective_fps, 4),
                "activity_level": activity_level,
                "proximity_distance": proximity,
                "tracking_valid": tracking_valid,
                "detection_count": detection_count,
                "occlusion_flag": occlusion_flag,
                "identity_confidence": round(identity_confidence, 4),
                "fly1_area": fly1_area,
                "fly2_area": fly2_area,
            })
            if out:
                out.write(frame)
            frame_num += 1
            if frame_num % 100 == 0:
                print(f"Processed {frame_num} frames...")
    finally:
        cap.release()
        if out:
            out.release()
        cv2.destroyAllWindows()

    pd.DataFrame(data).to_csv(args.output_csv, index=False)
    if args.output_events:
        write_events_json(
            data,
            effective_fps,
            args.output_events,
            args.proximity_threshold,
            args.bout_min_frames,
        )
    last_frame = data[-1]["frame"] if data else -1
    sync_ok = frame_sync_ok(
        frame_num, len(data), last_frame, expected_frame_count,
    )
    print(
        f"TRACKER_SYNC frames_processed={frame_num} csv_rows={len(data)} "
        f"expected_video_frames={expected_frame_count} sync_ok={str(sync_ok).lower()}"
    )
    if not sync_ok:
        print(
            "Error: frame integrity mismatch between tracker loop and CSV",
            file=sys.stderr,
        )
        return 2
    print(f"Tracking completed! Data saved to {args.output_csv}.")
    return 0


def main(argv: list[str] | None = None) -> int:
    return run_tracker(parse_args(argv))


if __name__ == "__main__":
    raise SystemExit(main())
