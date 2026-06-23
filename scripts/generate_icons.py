#!/usr/bin/env python3
"""Generate PWA icons for the English Study App with only the Python stdlib.

Draws a rounded indigo->purple gradient tile with a white "translation bubble"
(an indigo line + a green line, evoking Korean->English + completion).
No third-party deps (no PIL/ImageMagick available in this env).
"""
import os
import zlib
import struct

OUT_DIR = os.path.join(os.path.dirname(__file__), "..", "app", "icons")

# Brand colors (match the app's weekly-review gradient + accents)
TOP = (102, 126, 234)      # #667EEA
BOTTOM = (118, 75, 162)    # #764BA2
WHITE = (255, 255, 255)
INDIGO = (79, 70, 229)     # #4F46E5
GREEN = (16, 185, 129)     # #10B981


def lerp(a, b, t):
    return tuple(round(a[i] + (b[i] - a[i]) * t) for i in range(3))


def rounded_rect_contains(x, y, x0, y0, x1, y1, r):
    if x < x0 or x > x1 or y < y0 or y > y1:
        return False
    # corner checks
    cx = None
    cy = None
    if x < x0 + r and y < y0 + r:
        cx, cy = x0 + r, y0 + r
    elif x > x1 - r and y < y0 + r:
        cx, cy = x1 - r, y0 + r
    elif x < x0 + r and y > y1 - r:
        cx, cy = x0 + r, y1 - r
    elif x > x1 - r and y > y1 - r:
        cx, cy = x1 - r, y1 - r
    if cx is None:
        return True
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r


def make_icon(size, maskable=False):
    n = size
    buf = bytearray(n * n * 4)

    # Geometry. For maskable icons keep the tile full-bleed (safe zone handled
    # by the OS); content sits within the centered 80%.
    tile_r = 0 if maskable else int(n * 0.225)
    content_scale = 0.78 if maskable else 1.0

    # Bubble rect (relative to full size, then scaled toward center for maskable)
    def sx(fx):
        c = n / 2
        return c + (fx - c) * content_scale

    bx0, by0, bx1, by1 = sx(n * 0.20), sx(n * 0.27), sx(n * 0.80), sx(n * 0.66)
    br = (by1 - by0) * 0.28

    # Two "text" lines inside the bubble
    line_h = (by1 - by0) * 0.14
    l1y = by0 + (by1 - by0) * 0.34
    l2y = by0 + (by1 - by0) * 0.64
    l1x0, l1x1 = bx0 + (bx1 - bx0) * 0.16, bx0 + (bx1 - bx0) * 0.84
    l2x0, l2x1 = bx0 + (bx1 - bx0) * 0.16, bx0 + (bx1 - bx0) * 0.60

    # Bubble tail (little triangle at bottom-left)
    tail_apex_x = bx0 + (bx1 - bx0) * 0.30
    tail_base_x0 = bx0 + (bx1 - bx0) * 0.16
    tail_base_x1 = bx0 + (bx1 - bx0) * 0.40
    tail_top = by1 - 1
    tail_bottom = by1 + (by1 - by0) * 0.22

    for y in range(n):
        for x in range(n):
            idx = (y * n + x) * 4
            # Background tile with rounded corners
            if maskable or rounded_rect_contains(x, y, 0, 0, n - 1, n - 1, tile_r):
                col = lerp(TOP, BOTTOM, y / (n - 1))
                a = 255
            else:
                buf[idx:idx + 4] = bytes((0, 0, 0, 0))
                continue

            # Bubble (white)
            if rounded_rect_contains(x, y, bx0, by0, bx1, by1, br):
                # text lines
                if l1x0 <= x <= l1x1 and abs(y - l1y) <= line_h / 2:
                    col = INDIGO
                elif l2x0 <= x <= l2x1 and abs(y - l2y) <= line_h / 2:
                    col = GREEN
                else:
                    col = WHITE
                a = 255
            else:
                # tail triangle
                if tail_top <= y <= tail_bottom:
                    t = (y - tail_top) / max(1.0, (tail_bottom - tail_top))
                    # narrows toward apex going down
                    lx = tail_base_x0 + (tail_apex_x - tail_base_x0) * t
                    rx = tail_base_x1 + (tail_apex_x - tail_base_x1) * t
                    if lx <= x <= rx:
                        col = WHITE
                        a = 255

            buf[idx] = col[0]
            buf[idx + 1] = col[1]
            buf[idx + 2] = col[2]
            buf[idx + 3] = a

    return write_png_bytes(n, n, buf)


def write_png_bytes(width, height, rgba):
    def chunk(typ, data):
        return (struct.pack(">I", len(data)) + typ + data +
                struct.pack(">I", zlib.crc32(typ + data) & 0xffffffff))

    raw = bytearray()
    stride = width * 4
    for y in range(height):
        raw.append(0)  # filter type 0 (None)
        raw.extend(rgba[y * stride:(y + 1) * stride])

    sig = b"\x89PNG\r\n\x1a\n"
    ihdr = struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)
    idat = zlib.compress(bytes(raw), 9)
    return sig + chunk(b"IHDR", ihdr) + chunk(b"IDAT", idat) + chunk(b"IEND", b"")


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    targets = [
        ("icon-192.png", 192, False),
        ("icon-512.png", 512, False),
        ("icon-maskable-512.png", 512, True),
        ("apple-touch-icon-180.png", 180, True),
    ]
    for name, size, maskable in targets:
        png = make_icon(size, maskable)
        with open(os.path.join(OUT_DIR, name), "wb") as f:
            f.write(png)
        print("wrote", name, size, "maskable" if maskable else "")


if __name__ == "__main__":
    main()
