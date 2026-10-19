import { printableParts, referenceFiles } from "../hardware/lilo-device-concept/kit.mjs";
/** Local-only preview for the isolated hardware design artifact. */
import './build-device-concept.mjs';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../.tmp/lilo-device-concept/',import.meta.url));
const files=new Map([['/','index.html'],['/index.html','index.html'],['/style.css','style.css'],['/viewer.js','viewer.js'],['/brand.js','brand.js'],['/companion.svg','companion.svg']]);
for(const name of printableParts)files.set(`/parts/${name}.stl`,`parts/${name}.stl`);
for(const name of ['electronics.js','kit.mjs'])files.set('/'+name,name);
for(const name of referenceFiles)files.set('/components/'+name,'components/'+name);
const server=createServer(async(req,res)=>{const path=new URL(req.url,'http://localhost').pathname;const file=files.get(path);if(!file||req.method!=='GET'){res.writeHead(404);res.end();return}try{const bytes=await readFile(root+file);res.writeHead(200,{'Content-Type':(file.endsWith('.js')||file.endsWith('.mjs'))?'text/javascript; charset=utf-8':file.endsWith('.css')?'text/css; charset=utf-8':file.endsWith('.svg')?'image/svg+xml':file.endsWith('.stl')?'application/octet-stream':file.endsWith('.json')?'application/json; charset=utf-8':'text/html; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(bytes)}catch{res.writeHead(500);res.end('Preview file unavailable.')}});
server.on('error',()=>{console.error('Preview could not bind localhost:8794.');process.exitCode=1});server.listen(8794,'127.0.0.1',()=>console.log('LILO device concept: http://localhost:8794 — local preview only.'));
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>server.close());
