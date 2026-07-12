import importlib.util
import pathlib
import unittest

TRACKER_PATH = pathlib.Path(__file__).resolve().parents[1] / "tracker.py"
spec = importlib.util.spec_from_file_location("flyt_tracker", TRACKER_PATH)
tracker = importlib.util.module_from_spec(spec)
assert spec.loader is not None
spec.loader.exec_module(tracker)


class TrackerTests(unittest.TestCase):
    def test_zero_is_not_missing(self):
        self.assertEqual(tracker.value_or({"value": 0}, "value", 999), 0)
        self.assertEqual(tracker.value_or({"value": 0.0}, "value", 999), 0.0)

    def test_initial_detection_has_zero_velocity(self):
        self.assertEqual(tracker.displacement((0, 0), (100, 100), False), 0.0)
        self.assertGreater(tracker.displacement((0, 0), (3, 4), True), 0.0)

    def test_zero_proximity_generates_courtship(self):
        rows = [
            {"frame": i, "proximity_distance": 0, "identity_confidence": 1, "occlusion_flag": 1}
            for i in range(5)
        ]
        events = tracker.detect_events(rows, 30, proximity_threshold=60, bout_min_frames=5)
        self.assertEqual(events[0]["type"], "courtship_bout")
        self.assertEqual(events[0]["mean_proximity_px"], 0)

    def test_zero_confidence_generates_low_confidence_segment(self):
        rows = [
            {"frame": i, "proximity_distance": 999, "identity_confidence": 0, "occlusion_flag": 0}
            for i in range(30)
        ]
        events = tracker.detect_events(rows, 30, proximity_threshold=60, bout_min_frames=90)
        self.assertEqual(events[0]["type"], "low_confidence_segment")
        self.assertEqual(events[0]["min_identity_confidence"], 0)

    def test_roi_validation(self):
        self.assertEqual(tracker.parse_roi("1,2,3,4"), (1, 2, 3, 4))
        with self.assertRaises(ValueError):
            tracker.parse_roi("1,2")


if __name__ == "__main__":
    unittest.main()
