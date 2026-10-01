import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import {Matrix4,Vector3,Quaternion,Euler} from '../vendor/three/three.module.js';

const ROOT=path.resolve(import.meta.dirname,'..');
const ASSETS=path.join(ROOT,'assets');
const fbxFile=path.join(ASSETS,'source/Clothing_Cage_Templates/Clothing_Cage_Templates/Clothing_Cage_Template.fbx');
const shirtFile=path.join(ASSETS,'source/Tshirt-model.fbx');

/** Read FBX binary without exploding vertex seams or changing source topology. */
function readFbx(filename){
  const b=fs.readFileSync(filename),version=b.readUInt32LE(23);let off=27;
  const wide=version>=7500,headSize=wide?25:13;
  function integer(){const v=wide?Number(b.readBigUInt64LE(off)):b.readUInt32LE(off);off+=wide?8:4;return v;}
  function property(){const type=String.fromCharCode(b[off++]);let v;
    if(type==='Y'){v=b.readInt16LE(off);off+=2;}
    else if(type==='C'){v=!!b[off++];}
    else if(type==='I'){v=b.readInt32LE(off);off+=4;}
    else if(type==='F'){v=b.readFloatLE(off);off+=4;}
    else if(type==='D'){v=b.readDoubleLE(off);off+=8;}
    else if(type==='L'){v=Number(b.readBigInt64LE(off));off+=8;}
    else if(type==='S'||type==='R'){const len=b.readUInt32LE(off);off+=4;v=type==='S'?b.toString('utf8',off,off+len):b.subarray(off,off+len).toString('base64');off+=len;}
    else if('fdlibc'.includes(type)){
      const n=b.readUInt32LE(off),encoding=b.readUInt32LE(off+4),len=b.readUInt32LE(off+8);off+=12;
      let bytes=b.subarray(off,off+len);off+=len;if(encoding===1)bytes=zlib.inflateSync(bytes);
      const sizes={f:4,d:8,l:8,i:4,b:1,c:1},read={f:'readFloatLE',d:'readDoubleLE',l:'readBigInt64LE',i:'readInt32LE',b:'readUInt8',c:'readUInt8'};v=[];
      for(let i=0;i<n;i++)v.push(Number(bytes[read[type]](i*sizes[type])));
    }else throw new Error(`FBX property ${type} unsupported at ${off}`);
    return v;
  }
  function node(){const end=integer(),n=integer(),len=integer(),nameLen=b[off++];if(!end)return null;
    const name=b.toString('utf8',off,off+nameLen);off+=nameLen;const props=[];for(let i=0;i<n;i++)props.push(property());
    const children=[];while(off<end-headSize){const child=node();if(!child)break;children.push(child);}off=end;
    return {name,props,children};
  }
  const nodes=[];while(off<b.length-headSize){const n=node();if(!n)break;nodes.push(n);}
  return {version,nodes};
}
const one=(n,name)=>n?.children.find(c=>c.name===name);
const many=(n,name)=>n?.children.filter(c=>c.name===name)||[];
const value=(n,name)=>one(n,name)?.props[0];
function props70(n){return Object.fromEntries((one(n,'Properties70')?.children||[]).filter(c=>c.name==='P').map(c=>[c.props[0],c.props.slice(4)]));}
function extract(filename){const tree=readFbx(filename),objects=tree.nodes.find(n=>n.name==='Objects'),conns=tree.nodes.find(n=>n.name==='Connections');
  const geometries=many(objects,'Geometry').map(n=>({id:n.props[0],name:n.props[1].split('\0')[0],type:n.props[2],positions:value(n,'Vertices'),polygonIndices:value(n,'PolygonVertexIndex'),uvLayers:many(n,'LayerElementUV').map(uv=>({name:value(uv,'Name'),mapping:value(uv,'MappingInformationType'),reference:value(uv,'ReferenceInformationType'),uv:value(uv,'UV'),uvIndices:value(uv,'UVIndex')}))}));
  const models=many(objects,'Model').map(n=>({id:n.props[0],name:n.props[1].split('\0')[0],type:n.props[2],properties:props70(n)}));
  const deformers=many(objects,'Deformer').map(n=>({id:n.props[0],name:n.props[1].split('\0')[0],type:n.props[2],indices:value(n,'Indexes'),weights:value(n,'Weights'),transform:value(n,'Transform'),transformLink:value(n,'TransformLink')}));
  const connections=(conns?.children||[]).map(n=>n.props);
  return {version:tree.version,geometries,models,deformers,connections,settings:props70(tree.nodes.find(n=>n.name==='GlobalSettings'))};
}
function bounds(p){const min=[Infinity,Infinity,Infinity],max=[-Infinity,-Infinity,-Infinity];for(let i=0;i<p.length;i++) {const a=i%3;min[a]=Math.min(min[a],p[i]);max[a]=Math.max(max[a],p[i]);}return {min,max,size:min.map((v,i)=>max[i]-v)};}
const cages=extract(fbxFile),shirt=extract(shirtFile);
fs.writeFileSync(path.join(ASSETS,'source','cage-fbx-extracted.json'),JSON.stringify(cages));
fs.writeFileSync(path.join(ASSETS,'source','tshirt-fbx-extracted.json'),JSON.stringify(shirt));
const hash=p=>crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const clean=n=>n.replace(/\.\d+$/,'');
function transformPositions(pos,m){const v=new Vector3(),out=[];for(let i=0;i<pos.length;i+=3){v.fromArray(pos,i).applyMatrix4(m);out.push(v.x,v.y,v.z);}return out;}
function makeMatrix(p){const t=p['Lcl Translation']||[0,0,0],r=(p['Lcl Rotation']||[0,0,0]).map(x=>x*Math.PI/180),s=p['Lcl Scaling']||[1,1,1];return new Matrix4().compose(new Vector3(...t),new Quaternion().setFromEuler(new Euler(...r,'ZYX')),new Vector3(...s));}
function meshWorld(data,geom){const meshConn=data.connections.find(c=>c[0]==='OO'&&c[1]===geom.id),model=data.models.find(m=>m.id===meshConn[2]);function world(id){const m=data.models.find(m=>m.id===id);if(!m)return new Matrix4();const parentConn=data.connections.find(c=>c[0]==='OO'&&c[1]===id);return world(parentConn?.[2]).multiply(makeMatrix(m.properties));}return {model,positions:transformPositions(geom.positions,world(model.id))};}
function polygonsAndTriangles(poly){const polygons=[],indices=[],triangleCorners=[];let cur=[],corners=[];for(let c=0;c<poly.length;c++){const p=poly[c];cur.push(p<0?-p-1:p);corners.push(c);if(p<0){polygons.push(cur);for(let j=1;j<cur.length-1;j++){indices.push(cur[0],cur[j],cur[j+1]);triangleCorners.push(corners[0],corners[j],corners[j+1]);}cur=[];corners=[];}}return {polygons,indices,triangleCorners};}
function outputFbxMesh(data,geom,offset=[0,0,0]){const world=meshWorld(data,geom),positions=world.positions.map((v,i)=>v+offset[i%3]);const tri=polygonsAndTriangles(geom.polygonIndices),uv=geom.uvLayers[0];return {name:world.model.name,positions,indices:tri.indices,polygons:tri.polygons,polygonIndices:geom.polygonIndices,triangleCorners:tri.triangleCorners,uv:uv?.uv||[],uvIndices:uv?.uvIndices||[],uvMapping:uv?.mapping,uvReference:uv?.reference,bounds:bounds(positions),vertexCount:positions.length/3,polygonCount:tri.polygons.length,triangleCount:tri.indices.length/3};}
const cageWorld=meshWorld(cages,cages.geometries[0]).positions,cageBounds=bounds(cageWorld),cageOffset=[0,-cageBounds.min[1],-(cageBounds.max[2]+cageBounds.min[2])/2];
const cageMeshes=cages.geometries.map(g=>outputFbxMesh(cages,g,cageOffset));
const cageOutput={schemaVersion:1,units:'stud',axis:'Y-up',normalization:{offset:cageOffset},source:{url:'https://prod.docsiteassets.roblox.com/assets/modeling/meshes/reference-files/Clothing_Cage_Templates.zip',docs:'https://create.roblox.com/docs/art/accessories/rig-and-cage-existing-models',sha256:hash(fbxFile),zipSha256:hash(path.join(ASSETS,'source/Clothing_Cage_Templates.zip'))},inner:cageMeshes.find(m=>m.name.includes('InnerCage')),outer:cageMeshes.find(m=>m.name.includes('OuterCage'))};
assert.equal(cageOutput.inner.vertexCount,1358,'Unexpected Roblox cage vertex count');
assert.equal(cageOutput.outer.vertexCount,1358,'Unexpected Roblox outer cage vertex count');
assert.deepEqual(cageOutput.inner.polygonIndices,cageOutput.outer.polygonIndices,'Paired cage topology differs');
assert.deepEqual(cageOutput.inner.uv,cageOutput.outer.uv,'Paired cage UVs differ');
assert.deepEqual(cageOutput.inner.uvIndices,cageOutput.outer.uvIndices,'Paired cage UV indexing differs');
fs.writeFileSync(path.join(ASSETS,'roblox-cage.json'),JSON.stringify(cageOutput));
const shirtOutput={schemaVersion:1,units:'stud',axis:'Y-up',source:{url:'https://prod.docsiteassets.roblox.com/assets/accessories/reference-files/Tshirt-model.fbx',docs:'https://create.roblox.com/docs/avatar/resources',sha256:hash(shirtFile)},...outputFbxMesh(shirt,shirt.geometries[0])};
for(const mesh of [...cageMeshes,shirtOutput]){
  assert.ok(mesh.positions.every(Number.isFinite));
  assert.ok(mesh.indices.every(i=>Number.isInteger(i)&&i>=0&&i<mesh.vertexCount));
  assert.equal(mesh.polygonIndices.length,mesh.uvIndices.length,'Source corner count must match UV corner count');
}
fs.writeFileSync(path.join(ASSETS,'roblox-tshirt.json'),JSON.stringify(shirtOutput));

// Decode BloxLab's existing embedded GLB and preserve an exact original copy.
const embedded='D:/bloxlab/frontend/public/assets/skin-examples/r15-rig.json';
const glb=Buffer.from(JSON.parse(fs.readFileSync(embedded,'utf8')),'base64');fs.writeFileSync(path.join(ASSETS,'r15.glb'),glb);
const jsonLength=glb.readUInt32LE(12),gltf=JSON.parse(glb.subarray(20,20+jsonLength)),binStart=28+jsonLength;
const componentBytes={5120:1,5121:1,5122:2,5123:2,5125:4,5126:4},componentRead={5120:'readInt8',5121:'readUInt8',5122:'readInt16LE',5123:'readUInt16LE',5125:'readUInt32LE',5126:'readFloatLE'},dimensions={SCALAR:1,VEC2:2,VEC3:3,VEC4:4,MAT4:16};
function accessor(i){const a=gltf.accessors[i],v=gltf.bufferViews[a.bufferView],n=dimensions[a.type],bytes=componentBytes[a.componentType],stride=v.byteStride||n*bytes,start=binStart+(v.byteOffset||0)+(a.byteOffset||0),out=[];for(let j=0;j<a.count;j++)for(let k=0;k<n;k++)out.push(glb[componentRead[a.componentType]](start+j*stride+k*bytes));return out;}
const parents=new Map();gltf.nodes.forEach((n,i)=>n.children?.forEach(c=>parents.set(c,i)));const wm=new Map();
function nodeMatrix(i){if(wm.has(i))return wm.get(i);const n=gltf.nodes[i],local=n.matrix?new Matrix4().fromArray(n.matrix):new Matrix4().compose(new Vector3(...(n.translation||[0,0,0])),new Quaternion(...(n.rotation||[0,0,0,1])),new Vector3(...(n.scale||[1,1,1]))),world=parents.has(i)?nodeMatrix(parents.get(i)).clone().multiply(local):local;wm.set(i,world);return world;}
const r15Parts=[];gltf.nodes.forEach((n,i)=>{if(n.mesh===undefined)return;const p=gltf.meshes[n.mesh].primitives[0],positions=transformPositions(accessor(p.attributes.POSITION),nodeMatrix(i));r15Parts.push({name:clean(n.name),nodeIndex:i,positions,indices:accessor(p.indices),uv:accessor(p.attributes.TEXCOORD_0),bounds:bounds(positions),worldMatrix:nodeMatrix(i).toArray()});});
const r15Bounds=bounds(r15Parts.flatMap(p=>p.positions)),r15Offset=[-(r15Bounds.min[0]+r15Bounds.max[0])/2,-r15Bounds.min[1],-(r15Bounds.min[2]+r15Bounds.max[2])/2];
for(const p of r15Parts){p.positions=p.positions.map((v,i)=>v+r15Offset[i%3]);p.bounds=bounds(p.positions);}
const standard=['HumanoidRootPart','LowerTorso','UpperTorso','Head','LeftUpperArm','LeftLowerArm','LeftHand','RightUpperArm','RightLowerArm','RightHand','LeftUpperLeg','LeftLowerLeg','LeftFoot','RightUpperLeg','RightLowerLeg','RightFoot'];
const joints=[];for(const index of gltf.skins[0].joints){const n=gltf.nodes[index];if(!standard.includes(n.name))continue;const matrix=nodeMatrix(index),position=new Vector3().setFromMatrixPosition(matrix);position.add(new Vector3(...r15Offset));joints.push({name:n.name,nodeIndex:index,parentNodeIndex:parents.get(index),position:position.toArray(),worldMatrix:matrix.toArray(),localTranslation:n.translation,localRotation:n.rotation});}
const body={schemaVersion:1,units:'stud',axis:'Y-up',source:{file:embedded,sha256:hash(path.join(ASSETS,'r15.glb'))},normalization:{offset:r15Offset},parts:r15Parts,joints,bounds:bounds(r15Parts.flatMap(p=>p.positions))};
fs.writeFileSync(path.join(ASSETS,'r15-body.json'),JSON.stringify(body));
const manifest={generatedBy:'tools/prepare-assets.mjs',cage:{vertices:cageOutput.inner.vertexCount,polygons:cageOutput.inner.polygonCount,triangles:cageOutput.inner.triangleCount,bounds:cageOutput.inner.bounds,uvPairs:cageOutput.inner.uv.length/2,uvCornerCount:cageOutput.inner.uvIndices.length,sameInitialPositions:JSON.stringify(cageOutput.inner.positions)===JSON.stringify(cageOutput.outer.positions),sameInitialTopology:JSON.stringify(cageOutput.inner.polygonIndices)===JSON.stringify(cageOutput.outer.polygonIndices),sameInitialUV:JSON.stringify(cageOutput.inner.uv)===JSON.stringify(cageOutput.outer.uv)},r15:{parts:r15Parts.map(p=>({name:p.name,vertices:p.positions.length/3,bounds:p.bounds})),bounds:body.bounds,joints},shirt:{vertices:shirtOutput.vertexCount,polygons:shirtOutput.polygonCount,bounds:shirtOutput.bounds},sources:[cageOutput.source,shirtOutput.source,body.source]};
fs.writeFileSync(path.join(ASSETS,'manifest.json'),JSON.stringify(manifest,null,2));console.log(JSON.stringify({cage:manifest.cage,r15:{parts:manifest.r15.parts.length,bounds:manifest.r15.bounds,joints:manifest.r15.joints.length},shirt:manifest.shirt,sources:manifest.sources},null,2));

export {extract,bounds};
