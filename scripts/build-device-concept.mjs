import { printableParts, referenceFiles } from "../hardware/lilo-device-concept/kit.mjs";
/** Assemble an isolated design artifact; never included in daemon runtime builds. */
import { mkdir, readFile, writeFile, copyFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
const root=fileURLToPath(new URL("../",import.meta.url));
const output=resolve(root,".tmp","lilo-device-concept");
await mkdir(output,{recursive:true});
const brand=await readFile(resolve(root,"app/src/shared/brand/logoPaths.ts"),"utf8");
const split=brand.match(/export const MARK_SPLIT_D\s*=\s*"([^"]+)";/)?.[1];
if(!split)throw new Error("LILO brand split is missing.");
await writeFile(resolve(output,"brand.js"),`export const split = ${JSON.stringify(split)};\n`,"utf8");
// Bundle only the pure desktop geometry model to obtain an authentic companion still.
const {build}=await import('vite');
const bundled=await build({configFile:false,logLevel:'silent',build:{write:false,minify:false,lib:{entry:resolve(root,'hardware/lilo-device-concept/desktop-character.ts'),formats:['es']},rollupOptions:{output:{inlineDynamicImports:true}}}});
const result=Array.isArray(bundled)?bundled[0]:bundled;
const code=result.output.find(item=>item.type==='chunk')?.code;
if(!code)throw new Error('Desktop character could not be generated.');
const {desktopFrame:f}=await import('data:text/javascript,'+encodeURIComponent(code));
const eye=(value,fill)=>`<ellipse cx="${value.cx}" cy="${value.cy}" rx="${value.rx}" ry="${value.ry}" fill="${fill}"/>`;
const character=`<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400" viewBox="0 0 400 400"><defs><linearGradient id="ink" x1="90" y1="70" x2="310" y2="330" gradientUnits="userSpaceOnUse"><stop stop-color="#3b82f6"/><stop offset="1" stop-color="#22d3ee"/></linearGradient><clipPath id="split"><path d="${f.darkD}"/></clipPath></defs><rect width="400" height="400" fill="#070a10"/><g transform="${f.tilt}"><path d="${f.bodyD}" fill="#0b1422"/><g clip-path="url(#split)"><path d="${f.bodyD}" fill="url(#ink)"/></g>${eye(f.eyeLeft,'url(#ink)')}${eye(f.eyeRight,'#0b1422')}<path d="${f.mouthD}" opacity="${f.mouthOpacity}" fill="url(#ink)" stroke="url(#ink)" stroke-width="3" stroke-linecap="round"/><path d="${f.bodyD}" fill="none" stroke="url(#ink)" stroke-width="5"/></g></svg>`;
await writeFile(resolve(output,'companion.svg'),character,'utf8');
for(const name of ["index.html","style.css","viewer.js","electronics.js","kit.mjs"])await copyFile(resolve(root,"hardware/lilo-device-concept",name),resolve(output,name));
await mkdir(resolve(output,"parts"),{recursive:true});
for(const name of printableParts)await copyFile(resolve(root,"hardware/lilo-device-concept/parts",`${name}.stl`),resolve(output,"parts",`${name}.stl`));
console.log("Device concept assembled in .tmp/lilo-device-concept. Serve this directory through an HTTP server; never open the module entry as a file URL.");

await mkdir(resolve(output,"components"),{recursive:true});
for(const name of referenceFiles)await copyFile(resolve(root,"hardware/lilo-device-concept/components",name),resolve(output,"components",name));

const page=await readFile(resolve(output,"index.html"),"utf8");
await writeFile(resolve(output,"index.html"),page.replace("<!-- PRINT_PART_LINKS -->",printableParts.map(name=>`<li><a href="./parts/${name}.stl" download>${name.replaceAll("_"," ")} · STL</a></li>`).join("")));
