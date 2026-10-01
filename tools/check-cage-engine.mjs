import assert from 'node:assert/strict';
import fs from 'node:fs';
import { bindToCage, deformWithCage, rebindWithCorrespondence, createSurface, mergeBodyParts, diagnoseMesh, fitOuterCage, createDemoFit,createR15GarmentFit } from '../src/cage-engine.js';

const triangle={positions:[0,0,0, 2,0,0, 0,2,0],indices:[0,1,2]};
const garment=Float32Array.from([.4,.3,.2, 2.2,-.1,.15, -.1,1.7,-.3]);
const binding=bindToCage(garment,triangle);
const identity=deformWithCage(binding,triangle.positions);
identity.forEach((v,i)=>assert.ok(Math.abs(v-garment[i])<1e-6,'Rest identity must reproduce the independent garment.'));
const rotate=p=>p.flatMap((_,i)=>i%3===0?[-p[i+1],p[i],p[i+2]]:[]);
const rotated=deformWithCage(binding,rotate(triangle.positions));
const expected=rotate(Array.from(garment));
rotated.forEach((v,i)=>assert.ok(Math.abs(v-expected[i])<1e-6,'Transport must reproduce a rigid cage rotation.'));
assert.throws(()=>createSurface({positions:[NaN,0,0,1,0,0,0,1,0],indices:[0,1,2]}),/non-finite/);

function cube(name,cx=0) {
  const positions=[-1,-1,-1, 1,-1,-1, 1,1,-1, -1,1,-1, -1,-1,1, 1,-1,1, 1,1,1, -1,1,1];
  for(let i=0;i<positions.length;i+=3)positions[i]+=cx;
  return {name,positions,indices:[0,2,1,0,3,2,4,5,6,4,6,7,0,1,5,0,5,4,3,7,6,3,6,2,0,4,7,0,7,3,1,2,6,1,6,5]};
}
const union=createSurface(mergeBodyParts([cube('Torso'),cube('Arm',1.9)]));
assert.ok(union.distance([.95,0,0]).signed<0,'Overlapping solids must be treated as a union.');
const exited=union.project([.95,0,0],.03,[0,0,1]);
assert.ok(union.distance(exited).signed>=.025,'Projection must exit the entire union.');
const crossing={positions:[-2,0,0,2,0,0,0,3,0],indices:[0,1,2]};
const surface=createSurface(cube('Body'));
const onlyVertices=diagnoseMesh(crossing,surface,{includeFaces:false});
const faceSamples=diagnoseMesh(crossing,surface);
assert.equal(onlyVertices.penetrationSamples,0);
assert.ok(faceSamples.penetrationSamples>0,'Edge/face samples must detect intersections missed by vertices.');
const raisedPlane={positions:triangle.positions.map((v,i)=>i%3===2?v+.20:v),indices:triangle.indices};
const softenedOuter=fitOuterCage(triangle,raisedPlane,{thickness:.04,influence:Float32Array.from([.25,.25,.25]),iterations:6});
for(let i=2;i<softenedOuter.positions.length;i+=3)assert.ok(softenedOuter.positions[i]>=.205,'Partial cage influence must preserve measured cloth enclosure rather than shrink it.');

const load=name=>JSON.parse(fs.readFileSync(new URL(`../assets/${name}.json`,import.meta.url),'utf8'));
const cageAsset=load('roblox-cage'),tee=load('roblox-tshirt'),body=load('r15-body');
const fit=createDemoFit(cageAsset,tee,body);
for(const positions of [fit.innerPositions,fit.outerPositions,fit.garmentPositions])assert.ok([...positions].every(Number.isFinite));
assert.deepEqual([...fit.sourceCage.indices],cageAsset.inner.indices);
assert.deepEqual(fit.sourceCage.uv,cageAsset.inner.uv);
assert.equal(fit.innerPositions.length,cageAsset.inner.positions.length);
assert.equal(fit.outerPositions.length,cageAsset.outer.positions.length);
for(const influences of fit.influences)assert.ok(Math.abs(influences.reduce((sum,i)=>sum+i.weight,0)-1)<1e-6);
for(let i=0;i<fit.sourceCage.positions.length/3;i++) {
  const x=Math.abs(fit.sourceCage.positions[i*3]),y=fit.sourceCage.positions[i*3+1];
  if(x>1.35&&y<2.76&&y>2.60)assert.ok(fit.influences[i].every(w=>/Arm|Hand/.test(w.name)),'Template hands must follow arm bones, not legs.');
}
console.log('9 meaningful cage-engine checks passed: identity, rotation, finite input, union, union projection, edge intersection, partial-influence enclosure, template topology/UV, arm influences.');
if(process.argv.includes('--legacy'))console.log(JSON.stringify(fit.diagnostics,(key,value)=>key==='distances'||key==='badVertices'?undefined:value,2));
if(fs.existsSync(new URL('../assets/r15-shirt.json',import.meta.url))) {
  const independent=load('r15-shirt'),core=createR15GarmentFit(cageAsset,independent,body);
  assert.equal(independent.source.kind,'independent-parametric-garment');
  core.garmentPositions.forEach((v,i)=>assert.ok(Math.abs(v-independent.positions[i])<1e-6,'R15 cloth must retain its independently authored rest shape.'));
  const rebound=rebindWithCorrespondence(core.bindings,core.innerPositions,core.garmentPositions);
  const again=deformWithCage(rebound,core.innerPositions);
  again.forEach((v,i)=>assert.ok(Math.abs(v-core.garmentPositions[i])<1e-6));
  assert.equal(core.diagnostics.after.invalidSamples,0);
  assert.equal(core.diagnostics.after.penetrationSamples,0,'Authored R15 reference garment should clear the entire real body union at rest.');
  for(let i=0;i<core.outerInfluence.length;i++)if(core.outerInfluence[i]===0)for(let k=0;k<3;k++)assert.equal(core.outerPositions[i*3+k],core.innerPositions[i*3+k],'Uncovered outer regions must exactly retain the body inner cage.');
  console.log('5 independent-garment checks passed: actual source provenance, rest shape, canonical rebind identity, real-body rest clearance, uncovered cage regions.');
}
