export function proximityValue(row) {
  if (!row) return null;
  const rawProximity = row.proximity_distance;
  if (rawProximity === null || rawProximity === undefined || rawProximity === '') return null;
  const proximity = Number(rawProximity);
  if (!Number.isFinite(proximity)) return null;
  if (Number(row.occlusion_flag ?? 0) !== 0) return null;

  if (row.tracking_valid !== null && row.tracking_valid !== undefined && row.tracking_valid !== '') {
    if (Number(row.tracking_valid) !== 1) return null;
  } else if (row.detection_count !== null && row.detection_count !== undefined && row.detection_count !== '') {
    if (Number(row.detection_count) < 2) return null;
  } else if (
    row.fly1_area !== null && row.fly1_area !== undefined
    && row.fly2_area !== null && row.fly2_area !== undefined
  ) {
    if (!(Number(row.fly1_area) > 0 && Number(row.fly2_area) > 0)) return null;
  }

  return proximity;
}

export function computeAverageProximity(rows) {
  const values = rows.map(proximityValue).filter((value) => value !== null);
  if (!values.length) return 0;
  return Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
}

export function prismDistance(row) {
  return proximityValue(row) ?? '';
}
