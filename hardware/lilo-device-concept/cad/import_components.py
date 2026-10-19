"""Tessellate revision-checked manufacturer STEP references on a design workstation."""
import argparse
import hashlib
import json
from pathlib import Path
import cadquery as cq
from simplify_mesh import simplify_mesh

parser = argparse.ArgumentParser()
parser.add_argument('reference_dir', type=Path)
parser.add_argument('output_dir', type=Path)
args = parser.parse_args()
args.output_dir.mkdir(parents=True, exist_ok=True)
metadata = {}
references = [
    ('waveshare_amoled', 'waveshare-amoled.step', -90, {'panel': 664, 'pcb': 0}, 'd1d5de5a72683804c256f6e0b8665fd8cf1ef7eaf178f24caf0912bf495099c2', 'https://files.waveshare.com/wiki/ESP32-S3-Touch-AMOLED-1.75/ESP32-S3-Touch-AMOLED-1.75-3D.zip'),
    ('respeaker_lite', 'ReSpeakerLitev1.1.step', 180, {'pcb': 483}, '4a9585d0177dbcfc0efa7d740c8731d0848484c89ee47e4a0cc919afd65d1528', 'https://wiki.seeedstudio.com/reSpeaker_usb_v3/'),
]
for name, filename, rotation, layers, expected_hash, url in references:
    source = args.reference_dir / filename
    digest = hashlib.sha256(source.read_bytes()).hexdigest()
    if digest != expected_hash:
        raise ValueError(f'{name}: reference revision changed; review geometry before export')
    shape = cq.Compound.makeCompound(cq.importers.importStep(str(source)).vals())
    shape = shape.rotate((0, 0, 0), (1, 0, 0), rotation)
    box = shape.BoundingBox()
    shape = shape.translate((-(box.xmin + box.xmax) / 2, -(box.ymin + box.ymax) / 2, -box.zmin))
    solids = shape.Solids()
    selected_layers = {suffix: [solids[index]] for suffix, index in layers.items()}
    selected_layers['hardware'] = [solid for index, solid in enumerate(solids) if index not in layers.values()]
    preview_triangles = {}
    for suffix, selected in selected_layers.items():
        cq.exporters.export(cq.Compound.makeCompound(selected), str(args.output_dir / f'{name}_{suffix}.stl'), tolerance=.12, angularTolerance=.16)
        if suffix == 'hardware':
            preview_triangles[suffix] = simplify_mesh(args.output_dir / f'{name}_{suffix}.stl', 40000 if name == 'waveshare_amoled' else 30000)
    box = shape.BoundingBox()
    metadata[name] = {'sizeMm': [box.xlen, box.ylen, box.zlen], 'sourceSha256': digest, 'sourceUrl': url, 'solids': len(solids), 'presentationTriangles': preview_triangles}
(args.output_dir / 'sources.json').write_text(json.dumps(metadata, indent=2), encoding='utf-8')
print('Exported manufacturer references with revision hashes.')
