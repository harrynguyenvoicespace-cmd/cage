import { Matrix4, Vector3, Quaternion, Euler } from '../vendor/three/three.module.js';

const IDENTITY = new Matrix4();
const cleanName = (name) => String(name ?? '').replace(/\.\d+$/, '');

/**
 * Pose the real BloxLab R15 parts around the joints supplied in r15-body.json.
 * Matrices map WIDTH-SCALED world rest points to posed world points. The
 * transformPoint helper and posePoints accept original, unscaled world points
 * and apply width before those matrices.
 */
export function createR15Poser(bodyAsset) {
  const joints = bodyAsset.joints ?? [];
  const byNode = new Map(joints.map((joint) => [joint.nodeIndex, joint]));
  const byName = new Map(joints.map((joint) => [cleanName(joint.name), joint]));
  const parts = bodyAsset.parts ?? [];
  const point = new Vector3();

  function getState({ width = 1, pose = 'stand', time = 0 } = {}) {
    width = Number.isFinite(width) && width > 0 ? width : 1;
    time = Number.isFinite(time) ? time : 0;
    const angles = new Map();
    const set = (name, x = 0, y = 0, z = 0) => angles.set(name, [x, y, z]);

    if (pose === 'arms') {
      const lift = Math.PI / 3;
      set('LeftUpperArm', 0, 0, -lift);
      set('RightUpperArm', 0, 0, lift);
      set('LeftLowerArm', -Math.PI / 12);
      set('RightLowerArm', -Math.PI / 12);
      set('LeftHand', -0.055);
      set('RightHand', -0.055);
    } else if (pose === 'walk') {
      const swing = Math.sin(time * 2.7);
      const opposite = -swing;
      set('LeftUpperLeg', swing * 0.36);
      set('RightUpperLeg', opposite * 0.36);
      set('LeftLowerLeg', Math.max(0, -swing) * 0.43);
      set('RightLowerLeg', Math.max(0, -opposite) * 0.43);
      set('LeftFoot', -Math.max(0, -swing) * 0.14);
      set('RightFoot', -Math.max(0, -opposite) * 0.14);
      // A natural outward shoulder angle leaves space for the shirt beside
      // this block R15's touching torso/arms. This moves the actual body as
      // well as its cage, and is included in the independent pose checks.
      const outward = Math.PI / 15;
      set('LeftUpperArm', opposite * 0.28, 0, -outward);
      set('RightUpperArm', swing * 0.28, 0, outward);
      set('LeftLowerArm', -0.08 - Math.max(0, swing) * 0.16);
      set('RightLowerArm', -0.08 - Math.max(0, opposite) * 0.16);
      set('UpperTorso', 0, swing * 0.025, swing * 0.018);
      set('Head', 0, -swing * 0.025, -swing * 0.018);
    } else {
      pose = 'stand';
    }

    const matrices = Object.create(null);
    const solve = (name) => {
      name = cleanName(name);
      if (matrices[name]) return matrices[name];
      const joint = byName.get(name);
      if (!joint) return IDENTITY;
      const parent = byNode.get(joint.parentNodeIndex);
      const matrix = parent ? solve(parent.name).clone() : new Matrix4();
      const rotation = angles.get(name);
      if (rotation) {
        const [x, y, z] = joint.position;
        const pivot = new Vector3(x * width, y, z);
        const around = new Matrix4().makeTranslation(pivot.x, pivot.y, pivot.z)
          .multiply(new Matrix4().makeRotationFromQuaternion(
            new Quaternion().setFromEuler(new Euler(...rotation, 'XYZ')),
          ))
          .multiply(new Matrix4().makeTranslation(-pivot.x, -pivot.y, -pivot.z));
        // Parent motion comes first, then rotation around this joint in the
        // inherited rest frame. Descendants therefore follow their parents.
        matrix.multiply(around);
      }
      matrices[name] = matrix;
      return matrix;
    };
    joints.forEach((joint) => solve(joint.name));

    const posedParts = parts.map((part) => {
      const matrix = solve(part.name);
      const positions = new Float32Array(part.positions.length);
      for (let i = 0; i < positions.length; i += 3) {
        point.set(part.positions[i] * width, part.positions[i + 1], part.positions[i + 2])
          .applyMatrix4(matrix).toArray(positions, i);
      }
      return { name: cleanName(part.name), positions, indices: part.indices, uv: part.uv };
    });

    // Keep the displayed avatar on the floor during the walk demonstration.
    let floorOffset = 0;
    if (pose === 'walk') {
      let lowest = Infinity;
      for (const part of posedParts) {
        for (let i = 1; i < part.positions.length; i += 3) lowest = Math.min(lowest, part.positions[i]);
      }
      if (lowest < 0) {
        floorOffset = -lowest;
        const lift = new Matrix4().makeTranslation(0, floorOffset, 0);
        Object.values(matrices).forEach((matrix) => matrix.premultiply(lift));
        for (const part of posedParts) {
          for (let i = 1; i < part.positions.length; i += 3) part.positions[i] += floorOffset;
        }
      }
    }

    const posedJoints = joints.map((joint) => {
      point.set(joint.position[0] * width, joint.position[1], joint.position[2])
        .applyMatrix4(solve(joint.name));
      return { name: cleanName(joint.name), position: point.toArray(), parent: byNode.get(joint.parentNodeIndex)?.name ?? null };
    });

    return {
      width, pose, time, floorOffset, parts: posedParts, matrices, joints: posedJoints,
      transformPoint(name, restPoint, target = []) {
        const x = restPoint.x ?? restPoint[0];
        const y = restPoint.y ?? restPoint[1];
        const z = restPoint.z ?? restPoint[2];
        point.set(x * width, y, z).applyMatrix4(matrices[cleanName(name)] ?? IDENTITY);
        if (target.isVector3) return target.copy(point);
        return point.toArray(target);
      },
    };
  }

  return { getState, boneNames: joints.map((joint) => cleanName(joint.name)) };
}

/** Blend part transforms for each original cage vertex using named weights. */
export function posePoints(positions, influences, state) {
  const output = new Float32Array(positions.length);
  const rest = new Vector3();
  const transformed = new Vector3();
  const width = state.width ?? 1;
  for (let i = 0, vertex = 0; i < positions.length; i += 3, vertex++) {
    rest.set(positions[i] * width, positions[i + 1], positions[i + 2]);
    let total = 0, x = 0, y = 0, z = 0;
    const weights = influences?.[vertex] ?? [];
    for (const influence of weights) {
      const weight = influence.weight;
      if (!Number.isFinite(weight) || weight <= 0) continue;
      transformed.copy(rest).applyMatrix4(state.matrices[cleanName(influence.name)] ?? IDENTITY);
      x += transformed.x * weight;
      y += transformed.y * weight;
      z += transformed.z * weight;
      total += weight;
    }
    if (total > 0) {
      output[i] = x / total; output[i + 1] = y / total; output[i + 2] = z / total;
    } else {
      output[i] = rest.x; output[i + 1] = rest.y; output[i + 2] = rest.z;
    }
  }
  return output;
}
