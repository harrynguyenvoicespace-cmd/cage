/** Generalized winding numbers of the actual rendered outer cage. Keeping
 * multiplicity exposes overlapping cage regions instead of pretending a
 * single odd/even ray is a reliable enclosure test for a folded surface. */
export function windingNumbers(points, cage, indices) {
  const faces = new Float64Array(indices.length * 3);
  for (let i = 0; i < indices.length; i++) for (let k = 0; k < 3; k++) faces[i * 3 + k] = cage[indices[i] * 3 + k];
  const result = new Float32Array(points.length / 3);
  for (let p = 0; p < points.length; p += 3) {
    const x = points[p], y = points[p + 1], z = points[p + 2]; let sum = 0;
    for (let j = 0; j < faces.length; j += 9) {
      const ax = faces[j] - x, ay = faces[j + 1] - y, az = faces[j + 2] - z;
      const bx = faces[j + 3] - x, by = faces[j + 4] - y, bz = faces[j + 5] - z;
      const cx = faces[j + 6] - x, cy = faces[j + 7] - y, cz = faces[j + 8] - z;
      const la = Math.sqrt(ax * ax + ay * ay + az * az), lb = Math.sqrt(bx * bx + by * by + bz * bz), lc = Math.sqrt(cx * cx + cy * cy + cz * cz);
      const numerator = ax * (by * cz - bz * cy) + ay * (bz * cx - bx * cz) + az * (bx * cy - by * cx);
      const denominator = la * lb * lc + (ax * bx + ay * by + az * bz) * lc + (bx * cx + by * cy + bz * cz) * la + (cx * ax + cy * ay + cz * az) * lb;
      sum += 2 * Math.atan2(numerator, denominator);
    }
    result[p / 3] = sum / (4 * Math.PI);
  }
  return result;
}
