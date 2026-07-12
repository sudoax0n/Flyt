"""Safety wrapper around tracker.py.

It preserves the existing tracker implementation while fixing:
- invalid/zero FPS passed to VideoWriter,
- the initialization-frame velocity spike,
- event detection treating numeric zero as a missing value.
"""

import argparse
import csv
import json
import os
import runpy
import sys

import cv2


def parse_wrapper_args():
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("--input")
    parser.add_argument("--output-csv", default="fly_tracking_data.csv")
    parser.add_argument("--output-events")
    parser.add_argument("--proximity-threshold", type=float, default=60.0)
    parser.add_argument("--bout-min-frames", type=int, default=90)
    return parser.parse_known_args()[0]


def install_safe_video_writer():
    original_writer = cv2.VideoWriter

    def safe_writer(filename, fourcc, fps, frame_size, *args):
        effective_fps = fps if fps and fps > 0 else 30.0
        writer = original_writer(
            filename,
            fourcc,
            effective_fps,
            frame_size,
            *args,
        )
        if not writer.isOpened():
            raise RuntimeError(
                f"Could not create output video at {filename}"
            )
        return writer

    cv2.VideoWriter = safe_writer


def load_csv_rows(csv_path):
    if not os.path.exists(csv_path):
        return [], []
    with open(csv_path, "r", encoding="utf-8", newline="") as handle:
        reader = csv.DictReader(handle)
        return reader.fieldnames or [], list(reader)


def save_csv_rows(csv_path, fieldnames, rows):
    with open(csv_path, "w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(rows)


def numeric(row, key, default):
    value = row.get(key)
    if value in (None, ""):
        return default
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def fix_initial_velocity(csv_path):
    fieldnames, rows = load_csv_rows(csv_path)
    if not rows:
        return rows

    for row in rows:
        detected = (
            numeric(row, "fly1_area", 0.0) > 0
            or numeric(row, "fly2_area", 0.0) > 0
        )
        if detected:
            for key in (
                "fly1_speed",
                "fly2_speed",
                "fly1_speed_pxsec",
                "fly2_speed_pxsec",
            ):
                if key in row:
                    row[key] = "0.0"
            break

    save_csv_rows(csv_path, fieldnames, rows)
    return rows


def sustained_segments(rows, condition, minimum_frames):
    segments = []
    start = None

    for row in rows:
        frame = int(float(row["frame"]))
        if condition(row):
            if start is None:
                start = frame
        elif start is not None:
            end = frame - 1
            if end - start + 1 >= minimum_frames:
                segments.append((start, end))
            start = None

    if start is not None and rows:
        end = int(float(rows[-1]["frame"]))
        if end - start + 1 >= minimum_frames:
            segments.append((start, end))

    return segments


def event_record(event_id, event_type, start, end, fps, segment, reason):
    duration_frames = end - start + 1
    proximities = [numeric(row, "proximity_distance", 0.0) for row in segment]
    confidences = [numeric(row, "identity_confidence", 0.0) for row in segment]
    occlusions = [numeric(row, "occlusion_flag", 0.0) for row in segment]

    return {
        "id": event_id,
        "type": event_type,
        "start_frame": start,
        "end_frame": end,
        "start_time_sec": round(start / fps, 3),
        "end_time_sec": round(end / fps, 3),
        "duration_sec": round(duration_frames / fps, 3),
        "mean_proximity_px": round(
            sum(proximities) / len(proximities),
            2,
        ) if proximities else 0.0,
        "min_identity_confidence": round(
            min(confidences),
            4,
        ) if confidences else 0.0,
        "occlusion_fraction": round(
            sum(occlusions) / len(occlusions),
            4,
        ) if occlusions else 0.0,
        "detection_reason": reason,
    }


def read_effective_fps(events_path, input_path):
    if events_path and os.path.exists(events_path):
        try:
            with open(events_path, "r", encoding="utf-8") as handle:
                fps = float(json.load(handle).get("fps", 0))
                if fps > 0:
                    return fps
        except (OSError, ValueError, TypeError, json.JSONDecodeError):
            pass

    capture = cv2.VideoCapture(input_path) if input_path else None
    try:
        fps = capture.get(cv2.CAP_PROP_FPS) if capture else 0
        return fps if fps and fps > 0 else 30.0
    finally:
        if capture:
            capture.release()


def regenerate_events(rows, args):
    if not args.output_events:
        return

    fps = read_effective_fps(args.output_events, args.input)
    events = []
    counter = 1

    courtship = sustained_segments(
        rows,
        lambda row: (
            numeric(row, "proximity_distance", 999.0)
            < args.proximity_threshold
        ),
        max(1, args.bout_min_frames),
    )
    for start, end in courtship:
        segment = [
            row for row in rows
            if start <= int(float(row["frame"])) <= end
        ]
        events.append(event_record(
            f"evt-{counter:03d}",
            "courtship_bout",
            start,
            end,
            fps,
            segment,
            "proximity_sustained",
        ))
        counter += 1

    low_confidence = sustained_segments(
        rows,
        lambda row: numeric(row, "identity_confidence", 1.0) < 0.2,
        30,
    )
    for start, end in low_confidence:
        segment = [
            row for row in rows
            if start <= int(float(row["frame"])) <= end
        ]
        events.append(event_record(
            f"evt-{counter:03d}",
            "low_confidence_segment",
            start,
            end,
            fps,
            segment,
            "identity_confidence_low",
        ))
        counter += 1

    events.sort(key=lambda event: event["start_frame"])
    envelope = {
        "version": 1,
        "fps": round(fps, 3),
        "total_frames": len(rows),
        "detection_params": {
            "proximity_threshold_px": args.proximity_threshold,
            "bout_min_frames": max(1, args.bout_min_frames),
            "low_confidence_threshold": 0.2,
            "low_confidence_min_frames": 30,
        },
        "events": events,
    }
    with open(args.output_events, "w", encoding="utf-8") as handle:
        json.dump(envelope, handle, indent=2)


def main():
    args = parse_wrapper_args()
    install_safe_video_writer()
    tracker_path = os.path.join(os.path.dirname(__file__), "tracker.py")

    exit_code = 0
    try:
        runpy.run_path(tracker_path, run_name="__main__")
    except SystemExit as exc:
        exit_code = int(exc.code or 0)

    if exit_code == 0:
        rows = fix_initial_velocity(args.output_csv)
        regenerate_events(rows, args)

    raise SystemExit(exit_code)


if __name__ == "__main__":
    main()
