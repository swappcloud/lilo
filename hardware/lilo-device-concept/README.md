# Circular LILO device kit

A self-assembly mechanical prototype for a personal Linux voice station. The curved enclosure is 144 mm in diameter and 72 mm deep, with a 3 mm wall, integrated resting surface, snap-fit covers and separate electronics carriers. CAD and rendering tools belong to the design workstation, not the daemon runtime.

Start with the [assembly guide](ASSEMBLY.md), [component references](COMPONENTS.md) and [Linux installation guide](../../docs/headless-linux.md).

## Files

- `cad/enclosure.scad`: parametric printable geometry in millimetres.
- `kit.mjs`: canonical list of eight printable designs.
- `parts/`: shell, front, rear, tray, display clamp, audio cradle, speaker cradle and bezel. Print four display clamps.
- `cad/import_components.py` and `components/`: revision-checked manufacturer reference meshes for the Waveshare AMOLED and ReSpeaker Lite.
- `electronics.js`: drawing-based computer and dimensioned speaker reconstructions.
- `viewer.js`: assembled, exploded and rear views using the printable meshes.
- `images/` and `lilo-device-concept.glb`: presentation artifacts; GLB uses metres and is not a print file.

The selected Waveshare AMOLED glass is circular, 48.96 mm across; the active display is 43.76 mm across. The front opening is 48.3 mm. Cable paths illustrate routing rather than a tested harness. Physical fit, snap durability, cooling, acoustics and electrical operation require an assembled prototype.

## Preview and export

From the repository root:

```sh
node scripts/preview-device-concept.mjs
```

Open <http://localhost:8794>. The local-only preview provides assembled, exploded, transparent and rear views and loads Three.js from jsDelivr.

With OpenSCAD installed on the design workstation:

```sh
node scripts/export-device-stl.mjs
```

Review output in `.tmp/lilo-device-stl/` before updating the `parts/` snapshot. The viewer loads those same meshes. The builder obtains a deterministic frame from the shared desktop LiloModel. A static face does not establish an implemented physical-display renderer.

The AMOLED module has its own ESP32 controller and a radial USB-C connection. Display firmware and use of its onboard microphones require separate integration; the reference audio path uses ReSpeaker USB. See [component integration](COMPONENTS.md#display-and-microphone-integration).

Manufacturer hardware layers are simplified for the mobile preview. Their glass and PCB layers remain separate, and the printable enclosure meshes are not simplified. The full manufacturer references are linked in COMPONENTS.md.

## Regenerate manufacturer reference meshes

This optional step uses Python with the packages pinned in cad/requirements.txt on the design workstation. Download the linked manufacturer STEP files into a reference directory as waveshare-amoled.step and ReSpeakerLitev1.1.step, then run:

```sh
python cad/import_components.py reference-files components
```

Run that command from this hardware directory, using the Python executable for the workstation environment. The importer checks source hashes before export. Its VTK reduction applies only to the vendor hardware presentation layers; glass, PCB and printable enclosure geometry retain their separate exports. None of these packages is installed on the headless device.
