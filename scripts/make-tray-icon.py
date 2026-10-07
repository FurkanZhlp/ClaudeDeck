#!/usr/bin/env python3
"""Draws the macOS menu bar template icon (the app's spark mark) at 1x and 2x.

Template images are black plus alpha; macOS tints them for light and dark menu bars.
Usage: python3 scripts/make-tray-icon.py  (writes resources/trayTemplate.png and @2x)
"""
import math
from pathlib import Path

import numpy as np
from PIL import Image

SIZE_PT = 18
SUPERSAMPLE = 16
PETALS = 8
# Petal geometry in points, measured from the icon centre.
INNER_RADIUS = 2.6
INNER_WIDTH = 0.6
OUTER_RADIUS = 7.1
OUTER_WIDTH = 1.6
# The mark is slightly rotated so no petal points straight up, like the app icon.
ROTATION_DEG = 12

OUT_DIR = Path(__file__).resolve().parent.parent / 'resources'


def uneven_capsule(px, py, r1, r2, h):
    """Signed distance to a capsule along +y from (0,0) radius r1 to (0,h) radius r2."""
    px = np.abs(px)
    b = (r1 - r2) / h
    a = math.sqrt(1 - b * b)
    k = -b * px + a * py  # dot((-b, a), p)
    d_bottom = np.hypot(px, py) - r1
    d_top = np.hypot(px, py - h) - r2
    d_side = a * px + b * py - r1
    return np.where(k < 0, d_bottom, np.where(k > a * h, d_top, d_side))


def render(scale: int) -> Image.Image:
    n = SIZE_PT * scale * SUPERSAMPLE
    step = 1 / (scale * SUPERSAMPLE)
    coords = (np.arange(n) + 0.5) * step - SIZE_PT / 2
    x, y = np.meshgrid(coords, coords)
    dist = np.full(x.shape, np.inf)
    for i in range(PETALS):
        angle = math.radians(ROTATION_DEG + i * 360 / PETALS)
        # Rotate the sample points so the petal lies along +y.
        c, s = math.cos(angle), math.sin(angle)
        rx = c * x + s * y
        ry = -s * x + c * y
        d = uneven_capsule(rx, -ry - INNER_RADIUS, INNER_WIDTH, OUTER_WIDTH,
                           OUTER_RADIUS - INNER_RADIUS)
        dist = np.minimum(dist, d)
    mask = (dist <= 0).astype(np.float32)
    alpha = Image.fromarray((mask * 255).astype(np.uint8))
    size = SIZE_PT * scale
    alpha = alpha.resize((size, size), Image.LANCZOS)
    image = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    image.putalpha(alpha)
    return image


def main() -> None:
    render(1).save(OUT_DIR / 'trayTemplate.png')
    render(2).save(OUT_DIR / 'trayTemplate@2x.png')
    print('wrote', OUT_DIR / 'trayTemplate.png', 'and @2x')


if __name__ == '__main__':
    main()
