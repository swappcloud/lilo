import { printableParts } from "../hardware/lilo-device-concept/kit.mjs";
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

for (const name of printableParts) {
  test(`print part ${name} is closed, nondegenerate and sized in millimetres`, async () => {
    const source = await readFile(`hardware/lilo-device-concept/parts/${name}.stl`, 'utf8');
    const vertices = [...source.matchAll(/vertex\s+([-+\d.eE]+)\s+([-+\d.eE]+)\s+([-+\d.eE]+)/g)].map(match => match.slice(1).map(Number));
    assert.ok(vertices.length > 30 && vertices.length % 3 === 0);
    const edges = new Map();
    const parents = new Map();
    const find = vertex => {
      if (!parents.has(vertex)) parents.set(vertex,vertex);
      let root = vertex;
      while (parents.get(root) !== root) root = parents.get(root);
      while (parents.get(vertex) !== vertex) {
        const next = parents.get(vertex);
        parents.set(vertex,root);
        vertex = next;
      }
      return root;
    };
    let volume = 0;
    const key = vertex => vertex.map(value => value.toFixed(5)).join(',');
    for (let index = 0; index < vertices.length; index += 3) {
      const [a,b,c] = vertices.slice(index,index+3);
      assert.ok([...a,...b,...c].every(Number.isFinite));
      const cross = [b[1]*c[2]-b[2]*c[1], b[2]*c[0]-b[0]*c[2], b[0]*c[1]-b[1]*c[0]];
      volume += a.reduce((sum,value,axis) => sum + value*cross[axis], 0) / 6;
      for (const [start,end] of [[a,b],[b,c],[c,a]]) {
        assert.notEqual(key(start),key(end));
        const edge = [key(start),key(end)].sort().join('|');
        edges.set(edge, (edges.get(edge) ?? 0) + 1);
        parents.set(find(key(start)),find(key(end)));
      }
    }
    assert.ok([...edges.values()].every(count => count === 2), 'each edge has exactly two incident triangles');
    assert.equal(new Set([...parents.keys()].map(find)).size,1,'part is one connected solid');
    assert.ok(Math.abs(volume) > 10, 'part encloses a solid volume');
    const width = Math.max(...vertices.map(v=>v[0])) - Math.min(...vertices.map(v=>v[0]));
    assert.ok(width > 10 && width < 220, 'part dimensions fit the reference printer envelope');
  });
}


test('manufacturer reference layers have finite millimetre geometry and bounded viewer meshes', async () => {
  for (const [name,limit] of [['waveshare_amoled',50000],['respeaker_lite',40000]]) {
    const bytes = await readFile('hardware/lilo-device-concept/components/'+name+'_hardware.stl');
    const triangles = bytes.readUInt32LE(80);
    assert.equal(bytes.length,84+triangles*50,'binary STL size matches its triangle table');
    assert.ok(triangles > 1000 && triangles <= limit,'reference remains detailed within the mobile viewer budget');
    for(let offset=84;offset<bytes.length;offset+=50)for(let value=0;value<12;value++)assert.ok(Number.isFinite(bytes.readFloatLE(offset+value*4)));
  }
  const panel = await readFile('hardware/lilo-device-concept/components/waveshare_amoled_panel.stl');
  const x=[];
  for(let offset=84;offset<panel.length;offset+=50)for(let vertex=0;vertex<3;vertex++)x.push(panel.readFloatLE(offset+12+vertex*12));
  assert.ok(Math.abs(Math.max(...x)-Math.min(...x)-48.96)<0.2,'AMOLED glass preserves the manufacturer diameter');
});
