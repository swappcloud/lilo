"""Bound reference-mesh complexity for the mobile design viewer, not print geometry."""
from pathlib import Path
from vtkmodules.vtkIOGeometry import vtkSTLReader, vtkSTLWriter
from vtkmodules.vtkFiltersCore import vtkQuadricDecimation

def simplify_mesh(path: Path, triangle_budget: int) -> int:
    reader = vtkSTLReader()
    reader.SetFileName(str(path))
    reader.Update()
    count = reader.GetOutput().GetNumberOfPolys()
    if count <= triangle_budget:
        return count
    reduced = vtkQuadricDecimation()
    reduced.SetInputConnection(reader.GetOutputPort())
    reduced.SetTargetReduction(1 - triangle_budget / count)
    reduced.VolumePreservationOn()
    reduced.Update()
    temporary = path.with_suffix('.simplified.stl')
    writer = vtkSTLWriter()
    writer.SetFileName(str(temporary))
    writer.SetFileTypeToBinary()
    writer.SetInputConnection(reduced.GetOutputPort())
    if writer.Write() != 1:
        raise RuntimeError(f'{path.name}: simplified mesh could not be written')
    temporary.replace(path)
    return reduced.GetOutput().GetNumberOfPolys()
