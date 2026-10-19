/** Pi geometry reconstructed from its manufacturer drawing; no third-party CAD redistribution. */
import * as THREE from 'three';
export function raspberryPi4(materials) {
  const root = new THREE.Group(); root.name = 'Raspberry Pi 4 Model B';
  const add = (name, geometry, material, xyz) => { const mesh = new THREE.Mesh(geometry,material); mesh.name=name;mesh.position.set(...xyz.map(value=>value*.001));root.add(mesh);return mesh; };
  const box = (name,size,xyz,material) => add(name,new THREE.BoxGeometry(...size.map(v=>v*.001)),material,xyz);
  const shape = new THREE.Shape();
  shape.moveTo(-29.5,-28);shape.lineTo(49.5,-28);shape.quadraticCurveTo(52.5,-28,52.5,-25);shape.lineTo(52.5,25);shape.quadraticCurveTo(52.5,28,49.5,28);shape.lineTo(-29.5,28);shape.quadraticCurveTo(-32.5,28,-32.5,25);shape.lineTo(-32.5,-25);shape.quadraticCurveTo(-32.5,-28,-29.5,-28);
  for(const x of [-29,29])for(const y of [-24.5,24.5]){const hole=new THREE.Path();hole.absarc(x,y,1.35,0,Math.PI*2,true);shape.holes.push(hole);}
  const pcb=new THREE.ExtrudeGeometry(shape,{depth:1.6,bevelEnabled:false});pcb.scale(.001,.001,.001);add('85 × 56 mm PCB',pcb,materials.green,[0,0,0]);
  box('BCM2711 processor',[15,15,1.5],[2,0,2.35],materials.dark);
  box('Memory package',[11,13,1.2],[-17,1,2.2],materials.dark);
  box('Heatsink',[22,22,2],[2,0,4.1],materials.silver);
  for(let i=0;i<8;i++)box('Heatsink fin',[22,1,8],[2,-10+i*2.8,9.1],materials.silver);
  box('GPIO header',[51,5.2,2],[-3.6,24,2.6],materials.dark);
  for(let i=0;i<20;i++)for(const y of [22.7,25.3])box(`GPIO pin ${i*2+(y<24?1:2)}`,[.6,.6,7],[-27.8+i*2.54,y,7],materials.gold);
  for(const y of [-18,0]){
    box('Double USB-A housing',[18,15,16],[53,y,9.6],materials.silver);
    for(const z of [5.6,13.6]){box('USB-A socket',[.2,12,5.5],[62.1,y,z],materials.dark);box('USB contact tongue',[.4,10,1.8],[62.3,y,z],materials.blue);}
  }
  box('Ethernet housing',[21,16,13.5],[52,19,8.35],materials.silver);
  box('RJ45 opening',[.3,13,9],[62.7,19,8.6],materials.dark);
  for(let i=0;i<8;i++)box('RJ45 contact',[.4,.5,4],[62.9,15.5+i,9],materials.gold);
  // USB-C power is 11.2 mm from the PCB's left edge in the official DXF.
  box('Native USB-C power socket',[9,7.5,3.2],[-21.3,-25,3.2],materials.silver);
  box('USB-C power opening',[7.7,.2,2.2],[-21.3,-28.85,3.2],materials.dark);
  for(const x of [-3,10]){box('Micro HDMI',[7.4,7,3.2],[x,-25,3.2],materials.silver);box('HDMI opening',[5.8,.2,2],[x,-28.6,3.2],materials.dark);}
  box('3.5 mm audio jack',[6.5,12,6],[28,-24,4.6],materials.dark);
  box('MicroSD cage',[15,15,1.7],[-23,0,-.85],materials.silver);
  return root;
}
export function enclosedSpeaker(materials) {
  const group=new THREE.Group();group.name='Seeed 114993346 · 50 × 45 × 22 mm';
  const housing=new THREE.Mesh(new THREE.BoxGeometry(.050,.045,.022),materials.dark);housing.position.z=.011;group.add(housing);
  const diaphragm=new THREE.Mesh(new THREE.CircleGeometry(.018,64),materials.speaker);diaphragm.rotation.y=Math.PI;diaphragm.position.z=-.0002;group.add(diaphragm);
  const rim=new THREE.Mesh(new THREE.TorusGeometry(.019,.0015,12,64),materials.silver);rim.position.z=-.0003;group.add(rim);
  return group;
}
