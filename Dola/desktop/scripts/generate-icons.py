# /// script
# dependencies = ["pillow", "scipy"]
# ///
"""uv run Dola/desktop/scripts/generate-icons.py: export solid-purple icons without edge matte."""
from pathlib import Path

import numpy as np
from PIL import Image
from scipy.ndimage import distance_transform_edt

resources = Path(__file__).resolve().parents[1] / "resources"
source = Image.open(resources.parents[2] / "apps/desktop/assets/dreamyo-source.png").convert("RGBA")


def solid_background(image):
    pixels = np.array(image)
    rgb = pixels[:, :, :3].astype(float)
    visible = pixels[:, :, 3] > 0
    purple = visible & (rgb[:, :, 2] > 150) & (rgb[:, :, 2] - rgb[:, :, 0] > 100)
    cream = visible & (rgb[:, :, 0] >= rgb[:, :, 2]) & (rgb[:, :, 0] > 150)
    color = np.median(rgb[purple & (pixels[:, :, 3] == 255)], axis=0)
    # Rebase only mixed purple/cream contour pixels, preserving the artwork's
    # anti-aliasing instead of painting a hard edge around the dog.
    mixed = visible & (rgb[:, :, 2] > 150) & (rgb[:, :, 2] > rgb[:, :, 0]) & ~purple
    _, bg_index = distance_transform_edt(~purple, return_indices=True)
    _, fg_index = distance_transform_edt(~cream, return_indices=True)
    background = rgb[bg_index[0][mixed], bg_index[1][mixed]]
    foreground = rgb[fg_index[0][mixed], fg_index[1][mixed]]
    difference = foreground - background
    coverage = np.clip(np.sum((rgb[mixed] - background) * difference, axis=1) / np.sum(difference * difference, axis=1), 0, 1)[:, None]
    pixels[mixed, :3] = np.rint(foreground * coverage + color * (1 - coverage)).astype(np.uint8)
    pixels[purple, :3] = color.astype(np.uint8)
    return Image.fromarray(pixels)


def clean_edge(image):
    pixels = np.array(image)
    alpha = pixels[:, :, 3]
    # Preserve alpha and every opaque artwork pixel. Semi-transparent edge
    # colors come from the nearest opaque interior instead of a white matte.
    _, nearest = distance_transform_edt(alpha != 255, return_indices=True)
    edge = (alpha > 0) & (alpha < 255)
    pixels[edge, :3] = pixels[nearest[0][edge], nearest[1][edge], :3]
    pixels[alpha == 0, :3] = 0
    return Image.fromarray(pixels)


source = clean_edge(solid_background(source))
source.save(resources / "dreamyo-icon.png")
sizes = (16, 24, 32, 48, 64, 128, 256, 512, 1024)
frames = {size: clean_edge(source.resize((size, size), Image.Resampling.LANCZOS)) for size in sizes}
# PNG-backed ICNS avoids iconutil's legacy small-size RGB/mask conversion,
# which turns low-alpha purple perimeter pixels white.
frames[1024].save(resources / "dreamyo.icns", format="ICNS", append_images=list(frames.values()))
ico_sizes = [size for size in sizes if size <= 256]
frames[256].save(resources / "dreamyo.ico", format="ICO", sizes=[(size, size) for size in ico_sizes], append_images=[frames[size] for size in ico_sizes])
