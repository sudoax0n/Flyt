import assert from 'node:assert/strict';
import test from 'node:test';
import { computeAverageProximity, prismDistance, proximityValue } from '../src/metrics.js';

test('carried coordinates from missing detections do not bias proximity metrics', () => {
  const rows = [
    { proximity_distance: 10, tracking_valid: 1, detection_count: 2, occlusion_flag: 0 },
    { proximity_distance: 10, tracking_valid: 0, detection_count: 0, occlusion_flag: 0 },
    { proximity_distance: null, tracking_valid: 0, detection_count: 1, occlusion_flag: 1 },
    { proximity_distance: 30, tracking_valid: 1, detection_count: 2, occlusion_flag: 0 },
  ];
  assert.equal(computeAverageProximity(rows), 20);
  assert.equal(proximityValue(rows[1]), null);
  assert.equal(prismDistance(rows[1]), '');
});

test('legacy rows remain valid only when they contain a finite non-occluded observation', () => {
  assert.equal(proximityValue({ proximity_distance: 12, occlusion_flag: 0 }), 12);
  assert.equal(proximityValue({ proximity_distance: '', occlusion_flag: 0 }), null);
  assert.equal(proximityValue({ proximity_distance: 0, occlusion_flag: 1 }), null);
});
