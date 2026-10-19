import { printableParts } from "../hardware/lilo-device-concept/kit.mjs";
/** Export individual printable enclosure parts with a locally installed OpenSCAD. */
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
const output = resolve(process.argv[2] || '.tmp/lilo-device-stl');
const executable = process.env.LILO_OPENSCAD || 'openscad';
mkdirSync(output, { recursive: true });
for (const part of printableParts) {
  const result = spawnSync(executable, ['-o', resolve(output, `${part}.stl`), '-D', `part="${part}"`, resolve('hardware/lilo-device-concept/cad/enclosure.scad')], { stdio: 'inherit', env: { ...process.env, QT_QPA_PLATFORM: 'offscreen' } });
  if (result.error) throw new Error('OpenSCAD is required for CAD export. Set LILO_OPENSCAD to its executable path.', { cause: result.error });
  if (result.status !== 0) process.exit(result.status || 1);
}
console.log(`Exported enclosure parts to ${output}`);
