export function trackingObservationIsValid(row) {
  if (!row || Number(row.occlusion_flag ?? 0) !== 0) return false;
  if (row.tracking_valid !== null && row.tracking_valid !== undefined && row.tracking_valid !== '') {
    return Number(row.tracking_valid) === 1;
  }
  if (row.detection_count !== null && row.detection_count !== undefined && row.detection_count !== '') {
    return Number(row.detection_count) >= 2;
  }
  if (
    row.fly1_area !== null && row.fly1_area !== undefined
    && row.fly2_area !== null && row.fly2_area !== undefined
  ) {
    return Number(row.fly1_area) > 0 && Number(row.fly2_area) > 0;
  }
  return true;
}

export function proximityValue(row) {
  if (!trackingObservationIsValid(row)) return null;
  const rawProximity = row.proximity_distance;
  if (rawProximity === null || rawProximity === undefined || rawProximity === '') return null;
  const proximity = Number(rawProximity);
  return Number.isFinite(proximity) ? proximity : null;
}

export function computeAverageProximity(rows) {
  const values = rows.map(proximityValue).filter((value) => value !== null);
  if (!values.length) return 0;
  return Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
}

export function prismDistance(row) {
  return proximityValue(row) ?? '';
}

export function prismVelocity(row, flyKey) {
  if (!trackingObservationIsValid(row)) return '';
  const rawSpeed = row?.[`${flyKey}_speed_pxsec`] ?? row?.[`${flyKey}_speed`];
  if (rawSpeed === null || rawSpeed === undefined || rawSpeed === '') return '';
  const speed = Number(rawSpeed);
  return Number.isFinite(speed) ? speed : '';
}

/**
 * Summarize measured two-fly observation frames (Tracking validity).
 * Not identity accuracy or biological success — only observation quality metadata.
 * Prefer tracking_valid=1; fall back to detection_count/areas; else unavailable.
 */
export function summarizeTrackingValidity(rows) {
  if (!Array.isArray(rows) || rows.length === 0) {
    return { available: false, validFrames: null, totalFrames: 0, percent: null };
  }
  const totalFrames = rows.length;
  const hasTrackingValid = rows.some(
    (row) => row.tracking_valid !== null && row.tracking_valid !== undefined && row.tracking_valid !== '',
  );
  const hasDetection = rows.some(
    (row) => row.detection_count !== null && row.detection_count !== undefined && row.detection_count !== '',
  );
  const hasAreas = rows.some(
    (row) => (
      (row.fly1_area !== null && row.fly1_area !== undefined && row.fly1_area !== '')
      || (row.fly2_area !== null && row.fly2_area !== undefined && row.fly2_area !== '')
    ),
  );
  if (!hasTrackingValid && !hasDetection && !hasAreas) {
    return { available: false, validFrames: null, totalFrames, percent: null };
  }

  let validFrames = 0;
  rows.forEach((row) => {
    if (Number(row.occlusion_flag ?? 0) !== 0) return;
    if (hasTrackingValid) {
      if (Number(row.tracking_valid) === 1) validFrames += 1;
      return;
    }
    if (hasDetection) {
      if (Number(row.detection_count) >= 2) validFrames += 1;
      return;
    }
    if (Number(row.fly1_area) > 0 && Number(row.fly2_area) > 0) validFrames += 1;
  });

  const percent = totalFrames > 0
    ? Math.round((validFrames / totalFrames) * 1000) / 10
    : null;
  return { available: true, validFrames, totalFrames, percent };
}
