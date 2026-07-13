import importlib.util
import math
import pathlib
import unittest

TRACKER_PATH = pathlib.Path(__file__).resolve().parents[1] / "tracker.py"
spec = importlib.util.spec_from_file_location("flyt_tracker", TRACKER_PATH)
tracker = importlib.util.module_from_spec(spec)
assert spec.loader is not None
spec.loader.exec_module(tracker)


def row(frame, proximity, confidence=1.0, occlusion=0, area=100.0, tracking_valid=None):
    if tracking_valid is None:
        tracking_valid = int(occlusion == 0 and area > 0)
    return {
        "frame": frame,
        "proximity_distance": proximity,
        "identity_confidence": confidence,
        "occlusion_flag": occlusion,
        "fly1_area": area,
        "fly2_area": area,
        "tracking_valid": tracking_valid,
    }


class TrackerTests(unittest.TestCase):
    def test_zero_is_not_missing(self):
        self.assertEqual(tracker.value_or({"value": 0}, "value", 999), 0)
        self.assertEqual(tracker.value_or({"value": 0.0}, "value", 999), 0.0)

    def test_initial_detection_has_zero_velocity(self):
        self.assertEqual(tracker.displacement((0, 0), (100, 100), False), 0.0)
        self.assertEqual(tracker.displacement((0, 0), (3, 4), True), 5.0)

    def test_pitch_merge_core_columns_are_finite_not_nan(self):
        """One-contour merge: proximity=0, speeds measured when initialized (pitch)."""
        prev = (10.0, 10.0)
        merged = (13.0, 14.0)
        # Core values written when initialized + 1 contour (see run_tracker).
        f1_speed = float(math.dist(merged, prev))
        f2_speed = float(math.dist(merged, prev))
        proximity = 0.0
        tracking_valid = 0
        detection_count = 1
        self.assertEqual(f1_speed, 5.0)
        self.assertEqual(f2_speed, 5.0)
        self.assertEqual(proximity, 0.0)
        self.assertFalse(math.isnan(f1_speed))
        self.assertFalse(math.isnan(proximity))
        # Scientific aggregates must use metadata, not NaN core columns.
        merge_row = row(
            0, proximity=proximity, confidence=0.0, occlusion=1, tracking_valid=tracking_valid,
        )
        self.assertFalse(tracker.is_courtship_frame(merge_row, 60))
        self.assertEqual(detection_count, 1)

    def test_pitch_dropout_core_columns_hold_last_known(self):
        """Zero-contour dropout: hold coords, proximity=last separation, speed=0."""
        prev_f1 = (0.0, 0.0)
        prev_f2 = (30.0, 40.0)
        f1_coords, f2_coords = prev_f1, prev_f2
        f1_speed = f2_speed = 0.0
        proximity = float(math.dist(f1_coords, f2_coords))
        tracking_valid = 0
        detection_count = 0
        self.assertEqual(proximity, 50.0)
        self.assertEqual(f1_speed, 0.0)
        self.assertEqual(f2_speed, 0.0)
        dropout_row = row(
            0, proximity=proximity, confidence=0.0, occlusion=0, area=0.0,
            tracking_valid=tracking_valid,
        )
        self.assertFalse(tracker.is_courtship_frame(dropout_row, 60))
        self.assertEqual(detection_count, 0)

    def test_tracking_valid_only_for_two_fly_observation(self):
        two_fly = row(0, proximity=20, confidence=0.8, tracking_valid=1)
        self.assertTrue(tracker.is_courtship_frame(two_fly, 60))
        invalid = row(0, proximity=10, confidence=1.0, tracking_valid=0)
        self.assertFalse(tracker.is_courtship_frame(invalid, 60))

    def test_separate_confident_close_flies_generate_courtship(self):
        rows = [row(i, proximity=20, confidence=0.8) for i in range(5)]
        events = tracker.detect_events(rows, 30, proximity_threshold=60, bout_min_frames=5)
        self.assertEqual([event["type"] for event in events], ["courtship_bout"])
        self.assertEqual(events[0]["occlusion_fraction"], 0)

    def test_occluded_zero_proximity_never_generates_courtship(self):
        # Pitch writes proximity=0 on merges; metadata (not NaN) blocks courtship.
        rows = [row(i, proximity=0, confidence=0.0, occlusion=1, tracking_valid=0) for i in range(30)]
        events = tracker.detect_events(rows, 30, proximity_threshold=60, bout_min_frames=5)
        self.assertNotIn("courtship_bout", [event["type"] for event in events])
        self.assertEqual([event["type"] for event in events], ["low_confidence_segment"])

    def test_dropout_held_proximity_never_generates_courtship(self):
        # Pitch writes last-known proximity on dropouts; tracking_valid=0 excludes them.
        rows = [
            row(i, proximity=15, confidence=0.0, occlusion=0, area=0.0, tracking_valid=0)
            for i in range(30)
        ]
        events = tracker.detect_events(rows, 30, proximity_threshold=60, bout_min_frames=5)
        self.assertNotIn("courtship_bout", [event["type"] for event in events])

    def test_low_confidence_separate_flies_do_not_generate_courtship(self):
        rows = [row(i, proximity=10, confidence=0.1, occlusion=0) for i in range(30)]
        events = tracker.detect_events(rows, 30, proximity_threshold=60, bout_min_frames=5)
        self.assertNotIn("courtship_bout", [event["type"] for event in events])
        self.assertEqual(events[0]["type"], "low_confidence_segment")

    def test_missing_fly_area_does_not_generate_courtship(self):
        rows = [row(i, proximity=10, confidence=1.0, area=0) for i in range(10)]
        events = tracker.detect_events(rows, 30, proximity_threshold=60, bout_min_frames=5)
        self.assertNotIn("courtship_bout", [event["type"] for event in events])

    def test_assignment_confidence_can_fall_below_low_confidence_threshold(self):
        confidence = tracker.assignment_confidence((5, 0), (-5, 0), (0, 0), (0, 0))
        self.assertLess(confidence, tracker.LOW_CONFIDENCE_THRESHOLD)

    def test_frame_sync_treats_opencv_count_as_diagnostic_only(self):
        self.assertTrue(tracker.frame_sync_ok(10, 10, 9, 10))
        self.assertTrue(tracker.frame_sync_ok(8, 8, 7, 10))
        self.assertTrue(tracker.frame_sync_ok(8, 8, 7, 0))
        self.assertFalse(tracker.frame_sync_ok(8, 7, 6, 8))

    def test_invalid_tracking_observation_cannot_be_courtship(self):
        invalid = row(0, proximity=10, confidence=1.0, tracking_valid=0)
        self.assertFalse(tracker.is_courtship_frame(invalid, 60))
        self.assertTrue(tracker.is_low_confidence_frame(invalid))

    def test_event_mean_proximity_ignores_missing_values(self):
        segment = [
            row(0, proximity=20, confidence=0.8),
            row(1, proximity=float("nan"), confidence=0.0, tracking_valid=0),
        ]
        event = tracker.build_event_record(
            "evt-001", "low_confidence_segment", 0, 1, 30, segment, "test"
        )
        self.assertEqual(event["mean_proximity_px"], 20.0)

    def test_roi_validation(self):
        self.assertEqual(tracker.parse_roi("1,2,3,4"), (1, 2, 3, 4))
        with self.assertRaises(ValueError):
            tracker.parse_roi("1,2")


if __name__ == "__main__":
    unittest.main()
