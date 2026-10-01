import { bindMls } from './cage-mls.js';
import { deformWithCage } from './cage-engine.js';

// All decisions use the authored source mesh/cage, before any target is read.
// Broad volumetric support avoids large affine extrapolation on flat panels.
export const MANNEQUIN_BINDING_POLICY = Object.freeze({
  minimumNeighbors: 96,
  maximumNeighbors: 512,
  maximumAbsoluteWeight: 2,
  maximumL1Mass: 8,
  maximumSourceIdentityError: 1e-6,
});
const sourceCache = new WeakMap();

export function bindingCoefficientMetrics(bindings) {
  let maximumAbsoluteWeight = 0, maximumL1Mass = 0;
  for (const records of bindings.vertices) {
    let mass = 0;
    for (const record of records) {
      if (!Number.isFinite(record.weight)) throw new Error('Source cage binding contains a non-finite coefficient.');
      const weight = Math.abs(record.weight);
      maximumAbsoluteWeight = Math.max(maximumAbsoluteWeight, weight);
      mass += weight;
    }
    maximumL1Mass = Math.max(maximumL1Mass, mass);
  }
  return { maximumAbsoluteWeight, maximumL1Mass };
}

/** Build/cache one source-only coefficient object, reused across target bodies. */
export function createStableMannequinBindings(sourceFit, garmentAsset, sourceBodyAsset) {
  if (sourceCache.has(sourceFit)) return sourceCache.get(sourceFit);
  const original = bindingCoefficientMetrics(sourceFit.bindings);
  const attempts = [];
  for (const neighbors of [96, 128, 192, 256, 384, 512]) {
    const bindings = bindMls(sourceFit.sourceGarment.positions, sourceFit.innerPositions, {
      vertexGroups: sourceFit.vertexGroups,
      influences: sourceFit.influences,
      neighbors,
      maximumNeighbors: MANNEQUIN_BINDING_POLICY.maximumNeighbors,
      joints: sourceBodyAsset.joints,
      garmentIndices: sourceFit.sourceGarment.indices,
      pairedVertexOffset: garmentAsset.stats?.outsideVertexCount,
      seamBlend: { graph: true, torsoStart: .9, armEnd: 1.2, graphIterations: 24 },
    });
    const metrics = bindingCoefficientMetrics(bindings);
    attempts.push({ neighbors, ...metrics });
    if (metrics.maximumAbsoluteWeight > MANNEQUIN_BINDING_POLICY.maximumAbsoluteWeight
      || metrics.maximumL1Mass > MANNEQUIN_BINDING_POLICY.maximumL1Mass) continue;
    const sourceOutput = deformWithCage(bindings, sourceFit.innerPositions);
    const sourceIdentityError = sourceOutput.reduce((maximum, value, i) => Math.max(maximum, Math.abs(value - sourceFit.sourceGarment.positions[i])), 0);
    if (sourceIdentityError > MANNEQUIN_BINDING_POLICY.maximumSourceIdentityError) throw new Error('Stabilized source cage binding failed garment rest identity.');
    const stabilization = {
      method: 'source-only-volumetric-MLS-neighborhood-expansion',
      sourceOnly: true,
      targetDependent: false,
      sourceIdentityError,
      neighbors,
      policy: MANNEQUIN_BINDING_POLICY,
      original,
      stabilized: metrics,
      attempts,
    };
    bindings.statistics = { ...bindings.statistics, ...metrics, stabilization };
    const result = { bindings, stabilization };
    sourceCache.set(sourceFit, result);
    return result;
  }
  throw new Error('Source garment has no sufficiently stable volumetric cage support within the shared binding policy.');
}
