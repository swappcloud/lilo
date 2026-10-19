import * as THREE from 'three';
import {OrbitControls} from 'three/addons/controls/OrbitControls.js';
import {GLTFExporter} from 'three/addons/exporters/GLTFExporter.js';
import {STLLoader} from 'three/addons/loaders/STLLoader.js';
import {mergeVertices} from 'three/addons/utils/BufferGeometryUtils.js';
import {raspberryPi4,enclosedSpeaker} from './electronics.js';

const holder=document.getElementById('viewer');
const scene=new THREE.Scene();scene.background=new THREE.Color('#eeedf1');
const camera=new THREE.PerspectiveCamera(36,1,.001,8);camera.position.set(.29,.16,-.40);
const renderer=new THREE.WebGLRenderer({antialias:true});renderer.setPixelRatio(Math.min(devicePixelRatio,1.5));renderer.shadowMap.enabled=true;renderer.shadowMap.autoUpdate=false;renderer.outputColorSpace=THREE.SRGBColorSpace;renderer.toneMapping=THREE.ACESFilmicToneMapping;renderer.toneMappingExposure=1.0;
holder.append(renderer.domElement);
const controls=new OrbitControls(camera,renderer.domElement);controls.target.set(0,0,.044);controls.enableDamping=true;controls.minDistance=.22;controls.maxDistance=1.6;
scene.add(new THREE.HemisphereLight(0xffffff,0x7f7996,2.4));
const light=new THREE.DirectionalLight(0xffffff,2.9);light.position.set(.3,.4,-.5);light.castShadow=true;light.shadow.mapSize.set(1024,1024);light.shadow.camera.left=-.45;light.shadow.camera.right=.45;light.shadow.camera.top=.45;light.shadow.camera.bottom=-.45;light.shadow.camera.near=.01;light.shadow.camera.far=2;scene.add(light);
const matte=(color,extra={})=>new THREE.MeshStandardMaterial({color,roughness:.65,metalness:.04,...extra});
const m={ivory:matte('#f4f0e9'),face:matte('#252731'),violet:matte('#7566d9'),dark:matte('#1c202b'),green:matte('#275a47'),silver:matte('#9d9fa8',{metalness:.65,roughness:.35}),gold:matte('#bca668',{metalness:.65}),blue:matte('#4f759c'),speaker:matte('#333640'),glass:matte('#080b12',{roughness:.18,metalness:.1})};
const floor=new THREE.Mesh(new THREE.PlaneGeometry(1.6,1.6),new THREE.ShadowMaterial({opacity:.14}));floor.rotation.x=-Math.PI/2;floor.position.set(0,-.0661,.036);floor.receiveShadow=true;scene.add(floor);
const model=new THREE.Group();scene.add(model);const items=[];const cableItems=[];const loader=new STLLoader();
function register(name,object,xyz,spread=[0,0,0],rotation=[0,0,0]) {
  object.name=name;object.position.set(...xyz.map(v=>v*.001));object.rotation.set(...rotation);object.traverse(child=>{if(child.isMesh){child.castShadow=true;child.receiveShadow=true;}});model.add(object);items.push({object,base:object.position.clone(),offset:new THREE.Vector3(...spread.map(v=>v*.001))});return object;
}
async function mesh(file,material,smooth=false) {
  let geometry=await loader.loadAsync(file);geometry.scale(.001,.001,.001);
  if(smooth){geometry.deleteAttribute('normal');geometry=mergeVertices(geometry,1e-6);geometry.computeVertexNormals();}
  return new THREE.Mesh(geometry,material);
}
register('01 · Rounded body with integral foot',await mesh('./parts/shell.stl',m.ivory,true),[0,0,0]);
register('02 · Snap-fit front',await mesh('./parts/front.stl',m.face),[0,0,-3],[0,0,-110]);
register('03 · Press-fit accent bezel',await mesh('./parts/bezel.stl',m.violet),[0,8,-3.8],[0,0,-115]);
register('10 · Snap-fit rear and release slots',await mesh('./parts/rear.stl',m.ivory),[0,0,75],[0,0,115],[0,Math.PI,0]);
register('08 · Sliding Pi carrier',await mesh('./parts/tray.stl',m.dark),[-10,-20,44],[0,-15,62],[-Math.PI/2,0,0]);
for(const x of [-31,31])for(const y of [-2,18])register('Display retaining clip',await mesh('./parts/display_clamp.stl',m.violet),[x,y,4],[0,0,-50],[0,0,x>0?Math.PI:0]);
const displayGroup=new THREE.Group();
displayGroup.add(await mesh('./components/waveshare_amoled_panel.stl',m.glass));
displayGroup.add(await mesh('./components/waveshare_amoled_pcb.stl',m.green));
displayGroup.add(await mesh('./components/waveshare_amoled_hardware.stl',m.silver));
const faceImage=new Image();faceImage.src='./companion.svg';await faceImage.decode();
const faceCanvas=document.createElement('canvas');faceCanvas.width=512;faceCanvas.height=512;faceCanvas.getContext('2d').drawImage(faceImage,0,0,512,512);
const faceTexture=new THREE.CanvasTexture(faceCanvas);faceTexture.colorSpace=THREE.SRGBColorSpace;
const faceGeometry=new THREE.CircleGeometry(.02188,96);faceGeometry.rotateY(Math.PI);
const face=new THREE.Mesh(faceGeometry,new THREE.MeshBasicMaterial({map:faceTexture}));face.position.z=-.0001;displayGroup.add(face);
const display=register('04 · Waveshare ESP32-S3 AMOLED 1.75 · manufacturer CAD',displayGroup,[0,8,.5],[0,0,-55]);
const audioGroup=new THREE.Group();audioGroup.add(await mesh('./components/respeaker_lite_pcb.stl',m.green));audioGroup.add(await mesh('./components/respeaker_lite_hardware.stl',m.silver));
const audio=register('09 · ReSpeaker Lite · manufacturer CAD',audioGroup,[0,22,63],[35,22,92]);
register('ReSpeaker cradle',await mesh('./parts/audio_cradle.stl',m.dark),[-45,2.5,67.835],[35,22,92]);
const pi=register('07 · Raspberry Pi 4 Model B · drawing-based reconstruction',raspberryPi4(m),[-10,-11,44],[0,0,62],[-Math.PI/2,0,0]);
const speaker=register('06 · Seeed 114993346 · 4Ω 5W enclosed speaker',enclosedSpeaker(m),[0,-37,30],[0,-42,10]);
register('Speaker cradle',await mesh('./parts/speaker_cradle.stl',m.dark),[-28.3,-61.5,28],[0,-42,10]);
function cylinder(r,h,material) {const g=new THREE.CylinderGeometry(r,r,h,64);g.rotateX(Math.PI/2);return new THREE.Mesh(g,material);}
const power=new THREE.Group();const barrel=cylinder(.008,.017,m.silver);barrel.position.z=.005;power.add(barrel);const ring=cylinder(.009,.0018,m.silver);ring.position.z=-.004;power.add(ring);const button=cylinder(.0068,.0015,m.dark);button.position.z=-.005;power.add(button);
const powerButton=register('05 · Adafruit 481 · GPIO3 shutdown/wake button',power,[0,49,0],[0,0,-110]);
// Routes show actual separate leads and endpoints, not arbitrary duplicate electronics.
function cable(name,points,radius,color,from,to) {const material=matte(color);cableItems.push({name,points,radius,material,from,to,object:null});}
cable('USB display controller · firmware link',[[-23.5,8,8],[-36,8,12],[-38,45,20],[48,45,31],[53,-5.4,44]],1.3,'#6f6a83',display,pi);
cable('USB audio lead',[[53,-5.4,62],[64,0,59],[60,30,62],[-45,24,70]],1.5,'#4d5667',pi,audio);
cable('Speaker lead',[[-34,34,71],[-37,6,59],[-30,-34,50],[-24,-37,44]],.8,'#c98b6b',audio,speaker);
cable('GPIO3 / GND switch lead',[[0,49,15],[33,47,18],[37,35,28],[-33.9,-3,20]],.7,'#7b7b72',powerButton,pi);
let exploded=false,transparent=false;
function offsetFor(object) {return exploded?items.find(item=>item.object===object).offset:new THREE.Vector3();}
function refreshCables(){for(const c of cableItems){if(c.object){model.remove(c.object);c.object.geometry.dispose();}const start=offsetFor(c.from),end=offsetFor(c.to);const points=c.points.map((p,i)=>new THREE.Vector3(...p.map(v=>v*.001)).add(start.clone().lerp(end,i/(c.points.length-1))));c.object=new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(points),36,c.radius*.001,6,false),c.material);c.object.name=c.name;model.add(c.object);}}
function fitView(){const bounds=new THREE.Box3().setFromObject(model);const center=bounds.getCenter(new THREE.Vector3());const size=bounds.getSize(new THREE.Vector3()).length();controls.target.copy(center);camera.position.copy(center).add(new THREE.Vector3(.7,.4,-1).normalize().multiplyScalar(size*1.55));controls.update();}
function update(){for(const item of items)item.object.position.copy(item.base).add(exploded?item.offset:new THREE.Vector3());refreshCables();renderer.shadowMap.needsUpdate=true;fitView();}
const pressed=(id,value)=>document.getElementById(id).setAttribute('aria-pressed',String(value));
document.getElementById('assembled').onclick=()=>{exploded=false;pressed('assembled',true);pressed('exploded',false);update();};
document.getElementById('exploded').onclick=()=>{exploded=true;pressed('assembled',false);pressed('exploded',true);update();};
document.getElementById('transparent').onclick=()=>{transparent=!transparent;for(const material of [m.ivory,m.face]){material.transparent=transparent;material.opacity=transparent?.18:1;material.depthWrite=!transparent;}pressed('transparent',transparent);renderer.shadowMap.needsUpdate=true;};
document.getElementById('rear-view').onclick=()=>{const target=controls.target;camera.position.copy(target).add(new THREE.Vector3(-.2,.08,.4));controls.update();};
document.getElementById('rotate').onclick=()=>{controls.autoRotate=!controls.autoRotate;pressed('rotate',controls.autoRotate);};
document.getElementById('reset').onclick=fitView;
document.getElementById('download').onclick=async()=>{const data=await new GLTFExporter().parseAsync(model,{binary:true});const url=URL.createObjectURL(new Blob([data],{type:'model/gltf-binary'}));const link=document.createElement('a');link.href=url;link.download='lilo-device-concept.glb';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);};
new ResizeObserver(()=>{camera.aspect=holder.clientWidth/holder.clientHeight;camera.updateProjectionMatrix();renderer.setSize(holder.clientWidth,holder.clientHeight);}).observe(holder);
update();document.getElementById('loading').remove();renderer.setAnimationLoop(()=>{controls.update();renderer.render(scene,camera);});document.documentElement.dataset.conceptReady='true';
