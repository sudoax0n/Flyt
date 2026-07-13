import assert from 'node:assert/strict';
import test from 'node:test';
import {
  computeAverageProximity,
  prismDistance,
  prismVelocity,
  proximityValue,
  summarizeTrackingValidity,
} from '../src/metrics.js';

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

test('pitch-style finite merge/dropout core values are excluded via metadata', () => {
  // Tracker writes finite pitch-compatible cores; consumers consult tracking_valid.
  const merge = {
    proximity_distance: 0,
    tracking_valid: 0,
    detection_count: 1,
    occlusion_flag: 1,
    fly1_speed_pxsec: 90,
  };
  const dropout = {
    proximity_distance: 45,
    tracking_valid: 0,
    detection_count: 0,
    occlusion_flag: 0,
    fly1_speed_pxsec: 0,
  };
  const valid = {
    proximity_distance: 20,
    tracking_valid: 1,
    detection_count: 2,
    occlusion_flag: 0,
    fly1_speed_pxsec: 12,
  };
  assert.equal(proximityValue(merge), null);
  assert.equal(proximityValue(dropout), null);
  assert.equal(prismDistance(merge), '');
  assert.equal(prismVelocity(merge, 'fly1'), '');
  assert.equal(prismVelocity(dropout, 'fly1'), '');
  assert.equal(computeAverageProximity([merge, dropout, valid]), 20);
  assert.equal(prismVelocity(valid, 'fly1'), 12);
});

test('legacy rows remain valid only when they contain a finite non-occluded observation', () => {
  assert.equal(proximityValue({ proximity_distance: 12, occlusion_flag: 0 }), 12);
  assert.equal(proximityValue({ proximity_distance: '', occlusion_flag: 0 }), null);
  assert.equal(proximityValue({ proximity_distance: 0, occlusion_flag: 1 }), null);
});


test('invalid or merged observations export blank individual-fly velocities', () => {
  const invalid = {
    tracking_valid: 0,
    detection_count: 1,
    occlusion_flag: 1,
    fly1_speed_pxsec: 120,
    fly2_speed_pxsec: 95,
  };
  assert.equal(prismVelocity(invalid, 'fly1'), '');
  assert.equal(prismVelocity(invalid, 'fly2'), '');
  assert.equal(prismVelocity({
    tracking_valid: 1,
    detection_count: 2,
    occlusion_flag: 0,
    fly1_speed_pxsec: 42.5,
  }, 'fly1'), 42.5);
});

test('summarizeTrackingValidity counts tracking_valid=1 and marks pure legacy unavailable', () => {
  const summary = summarizeTrackingValidity([
    { tracking_valid: 1, occlusion_flag: 0 },
    { tracking_valid: 0, occlusion_flag: 0 },
    { tracking_valid: 1, occlusion_flag: 1 },
    { tracking_valid: 1, occlusion_flag: 0 },
  ]);
  assert.equal(summary.available, true);
  assert.equal(summary.validFrames, 2);
  assert.equal(summary.totalFrames, 4);
  assert.equal(summary.percent, 50);

  const legacy = summarizeTrackingValidity([
    { proximity_distance: 10, occlusion_flag: 0 },
    { proximity_distance: 12, occlusion_flag: 0 },
  ]);
  assert.equal(legacy.available, false);
  assert.equal(legacy.validFrames, null);
  assert.equal(legacy.totalFrames, 2);
});
