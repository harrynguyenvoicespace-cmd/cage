import { readFile, writeFile } from 'node:fs/promises';
import { createR15Shirt } from '../src/garment.js';
const root = new URL('../', import.meta.url);
const body = JSON.parse(await readFile(new URL('assets/r15-body.json', root), 'utf8'));
const shirt = createR15Shirt(body);
await writeFile(new URL('assets/r15-shirt.json', root), JSON.stringify(shirt));
console.log(`${shirt.positions.length / 3} vertices, ${shirt.indices.length / 3} triangles`);
