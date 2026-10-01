import {
  createR15GarmentFit,
  deformWithCage,
  diagnoseMesh,
  deformationDiagnostics,
} from './cage-engine.js';
import { createStableMannequinBindings } from './mannequin-binding.js';
import { fitMannequinRestContacts } from './mannequin-contact.js';

const maximumDifference = (a, b) => a.reduce((maximum, value, i) => Math.max(maximum, Math.abs(value - b[i])), 0);

/** Check the importer supplied a canonical UV correspondence, not FBX vertex order. */
export function validateMannequinSeed(cageAsset, targetSeed, targetBodyAsset) {
  const canonical = cageAsset.inner || cageAsset;
  const count = canonical.positions.length / 3;
  if (targetSeed?.positions?.length !== canonical.positions.length || !targetSeed.positions.every(Number.isFinite)) {
    throw new Error('Imported mannequin cage must provide finite positions for every canonical cage vertex.');
  }
  if (targetSeed.canonicalUv?.length !== canonical.uv.length
    || !targetSeed.canonicalUv.every(Number.isFinite)
    || maximumDifference(targetSeed.canonicalUv, canonical.uv) > 1e-7) {
    throw new Error('Imported mannequin cage is missing its verified canonical UV ordering.');
  }
  if (targetSeed.canonicalIndices?.length !== canonical.indices.length
    || targetSeed.canonicalIndices.some((id, i) => id !== canonical.indices[i])
  ) throw new Error('Imported mannequin cage is missing its verified canonical triangle topology.');
  if (targetSeed.influences?.length !== count) throw new Error('Imported mannequin cage must provide one named skin field per canonical vertex.');
  const partNames = new Set((targetBodyAsset.parts || []).map(part => part.name));
  const jointNames = new Set((targetBodyAsset.joints || []).map(joint => joint.name));
  for (const weights of targetSeed.influences) {
    if (!weights.length || weights.some(weight => !Number.isFinite(weight.weight) || weight.weight <= 0 || !partNames.has(weight.name) || !jointNames.has(weight.name))) {
      throw new Error('Imported mannequin skin field refers to a missing part or joint.');
    }
    const sum = weights.reduce((total, weight) => total + weight.weight, 0);
    if (Math.abs(sum - 1) > 1e-5) throw new Error('Imported mannequin skin weights must be normalized.');
  }
  return {
    ...targetSeed.diagnostics,
    vertexCount: count,
    canonicalUvVerified: true,
    canonicalTrianglesVerified: true,
  };
}

/**
 * Transfer the existing, body-authored R15 garment through the shared cage UVs.
 * The same source-derived MLS coefficients drive every imported body and pose;
 * no garment recipe is rerun. Optional rest contacts adjust cage controls only.
 * The target fit's independent binding is used only to build its outer envelope.
 */
export function createMannequinGarmentFit(cageAsset, garmentAsset, sourceBodyAsset, targetBodyAsset, {
  sourceSeed,
  targetSeed,
  sourceFit = null,
  fitContacts = false,
  sourceId = sourceBodyAsset.id || sourceBodyAsset.name || 'r15',
  targetId = targetBodyAsset.id || targetBodyAsset.name || 'uploaded-mannequin',
  ...fitOptions
} = {}) {
  if (!sourceSeed && !sourceFit) throw new Error('Garment transfer requires the source mannequin canonical cage seed.');
  if (fitOptions.initialization === 'heuristic') throw new Error('Imported mannequin transfer requires canonical UV initialization.');
  const correspondence = validateMannequinSeed(cageAsset, targetSeed, targetBodyAsset);
  const originalFit = sourceFit || createR15GarmentFit(cageAsset, garmentAsset, sourceBodyAsset, {
    ...fitOptions, targetSeed: sourceSeed,
  });
  if (originalFit.bindings.method !== 'weighted-affine-cage-coordinates') throw new Error('Imported mannequin transfer requires the original affine cage bindings.');
  if (originalFit.initialization !== 'canonical-uv-target') throw new Error('Source garment fit must use its canonical UV cage seed.');
  if (sourceSeed && (
    originalFit.innerPositions.length !== sourceSeed.positions?.length
    || maximumDifference(originalFit.innerPositions, Float32Array.from(sourceSeed.positions)) > 1e-7
  )) throw new Error('Cached source fit belongs to another source mannequin cage.');
  if (originalFit.sourceGarment.positions.length !== garmentAsset.positions.length || originalFit.sourceGarment.indices.length !== garmentAsset.indices.length) {
    throw new Error('Cached source fit belongs to another garment topology.');
  }
  if (maximumDifference(originalFit.sourceGarment.positions, garmentAsset.positions) > 1e-6
    || originalFit.sourceGarment.indices.some((id, i) => id !== garmentAsset.indices[i])) {
    throw new Error('Cached source fit belongs to another authored garment.');
  }

  const stableSource = createStableMannequinBindings(originalFit, garmentAsset, sourceBodyAsset);
  const sourceBindings = stableSource.bindings;

  // Match the position precision used by the existing pose/fit engine.
  const targetRestPositions = Float32Array.from(targetSeed.positions);
  const transferredPositions = deformWithCage(sourceBindings, targetRestPositions);
  const transferredAsset = {
    ...garmentAsset,
    positions: transferredPositions,
    // Keep the authored indices, UVs, shell pairing, and Head/torso ownership.
    indices: garmentAsset.indices,
    uv: garmentAsset.uv,
    vertexGroups: garmentAsset.vertexGroups,
    vertexParts: garmentAsset.vertexParts,
  };
  let targetFit = createR15GarmentFit(cageAsset, transferredAsset, targetBodyAsset, {
    ...fitOptions, targetSeed, cageProjectionIterations: 0,
  });
  let finalAsset = transferredAsset, restContact = null;
  if (fitContacts) {
    const contact = fitMannequinRestContacts(sourceBindings, targetRestPositions, garmentAsset,
      targetBodyAsset, targetFit.body, targetFit.sourceCage.indices);
    restContact = contact.report;
    if (restContact.applied) {
      finalAsset = { ...transferredAsset, positions: contact.garment };
      targetFit = createR15GarmentFit(cageAsset, finalAsset, targetBodyAsset, {
        ...fitOptions, targetSeed: { ...targetSeed, positions: contact.inner }, cageProjectionIterations: 0,
      });
    }
  }
  const restOutput = deformWithCage(sourceBindings, targetFit.innerPositions);
  const restIdentityError = maximumDifference(restOutput, finalAsset.positions);
  if (restIdentityError > 1e-6) throw new Error('Imported mannequin rest cage changed during garment transfer.');
  const originalPositions = originalFit.sourceGarment.positions;
  let maximumDisplacement = 0, squaredDisplacement = 0;
  for (let i = 0; i < originalPositions.length; i += 3) {
    const distance = Math.hypot(...[0, 1, 2].map(axis => restOutput[i + axis] - originalPositions[i + axis]));
    maximumDisplacement = Math.max(maximumDisplacement, distance);
    squaredDisplacement += distance * distance;
  }
  const stretch = deformationDiagnostics(originalPositions, restOutput, garmentAsset.indices);
  const sourceIndicesPreserved = targetFit.sourceGarment.indices.every((id, i) => id === garmentAsset.indices[i]);
  const sourceUvsPreserved = targetFit.sourceGarment.uv === garmentAsset.uv;
  return {
    ...targetFit,
    sourceGarment: originalFit.sourceGarment,
    transferredGarment: finalAsset,
    bindings: sourceBindings,
    stableSourceBindings: sourceBindings,
    garmentPositions: restOutput,
    rawGarmentPositions: Float32Array.from(transferredPositions),
    authoredInnerPositions: Float32Array.from(targetRestPositions),
    rawInnerPositions: Float32Array.from(targetRestPositions),
    restContact,
    // Preserve the source's coherent semantic field for optional envelope skin.
    garmentInfluences: sourceBindings.regionWeights.map((weights, i) => weights || originalFit.garmentInfluences[i]),
    initialization: 'uploaded-canonical-uv-transfer',
    transfer: {
      method: 'original-garment-stable-source-MLS-through-canonical-UV-cage',
      sourceId,
      targetId,
      sourceGarmentName: garmentAsset.name,
      originalBindingsReused: false,
      sourceBindingsReusedAcrossTargets: true,
      bindingStabilization: stableSource.stabilization,
      regeneratedGarment: false,
      collisionRepairApplied: restContact?.applied || false,
      restContact,
      vertexCount: garmentAsset.positions.length / 3,
      triangleCount: garmentAsset.indices.length / 3,
      sourceIndicesPreserved,
      sourceUvsPreserved,
      semanticGroupsPreserved: transferredAsset.vertexGroups === garmentAsset.vertexGroups,
      maximumRestIdentityError: restIdentityError,
      maximumDisplacement,
      rmsDisplacement: Math.sqrt(squaredDisplacement / (originalPositions.length / 3)),
      stretch,
      correspondence,
      targetRigSource: targetBodyAsset.rigSource || targetBodyAsset.jointSource || targetBodyAsset.source?.rig || null,
      outerEnvelopeBinding: 'target-rest-only; displayed garment always uses shared stable source bindings',
    },
    diagnostics: {
      ...targetFit.diagnostics,
      rawTransfer: diagnoseMesh({ positions: transferredPositions, indices: garmentAsset.indices }, targetFit.body, { robust: true }),
      before: diagnoseMesh(originalFit.sourceGarment, targetFit.body, { robust: true }),
      after: diagnoseMesh({ positions: restOutput, indices: garmentAsset.indices }, targetFit.body, { robust: true }),
      stretch,
      sourceBindingStatistics: sourceBindings.statistics,
      originalBindingStatistics: originalFit.bindings.statistics,
    },
  };
}
