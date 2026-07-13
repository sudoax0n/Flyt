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
