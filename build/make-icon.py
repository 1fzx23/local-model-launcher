"""
Generate the launcher app icon.

The repo previously had no icon at all: build/icon.ico was referenced from
package.json but the file did not exist, so every build silently fell back to
the default Electron icon. This script draws one and writes a multi-resolution
.ico (Windows picks the best size per DPI) plus a 256px PNG preview.

Palette follows the app's dark theme (#0d1117 background) with the cyan accent
already used across the UI.
"""
from PIL import Image, ImageDraw

SIZES = [16, 24, 32, 48, 64, 128, 256]
BG = (13, 17, 23)        # #0d1117
ACCENT = (88, 205, 231)  # cyan
ACCENT_DIM = (56, 139, 160)


def draw_icon(px: int) -> Image.Image:
    img = Image.new("RGBA", (px, px), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    # Rounded-square background with a subtle vertical gradient.
    r = max(2, px // 5)
    grad_top = (22, 27, 34)
    grad_bot = (10, 13, 18)
    for y in range(px):
        t = y / max(1, px - 1)
        col = tuple(int(grad_top[i] + (grad_bot[i] - grad_top[i]) * t) for i in range(3))
        d.line([(0, y), (px, y)], fill=col + (255,))

    # Mask the gradient into a rounded rect.
    mask = Image.new("L", (px, px), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, px - 1, px - 1], radius=r, fill=255)
    img.putalpha(mask)

    cx, cy = px / 2, px / 2
    unit = px / 100.0  # work in a 100x100 design space

    # --- Glyph: a chip with pins (local inference on your own machine) ---
    chip_w, chip_h = 46 * unit, 34 * unit
    x0, y0 = cx - chip_w / 2, cy - chip_h / 2
    x1, y1 = cx + chip_w / 2, cy + chip_h / 2
    d.rounded_rectangle([x0, y0, x1, y1], radius=max(1, 4 * unit), fill=(30, 38, 48, 255),
                        outline=ACCENT, width=max(1, int(2.4 * unit)))

    # Three pins on each side.
    pin = max(1, int(2.0 * unit))
    plen = 7 * unit
    for frac in (0.28, 0.5, 0.72):
        py = y0 + chip_h * frac
        d.line([(x0 - plen, py), (x0, py)], fill=ACCENT_DIM, width=pin)
        d.line([(x1, py), (x1 + plen, py)], fill=ACCENT_DIM, width=pin)

    # Inner "play / launch" triangle — this is a launcher, after all.
    tri_w, tri_h = 17 * unit, 19 * unit
    tx, ty = cx - tri_w / 2, cy - tri_h / 2
    d.polygon(
        [(tx, ty), (tx, ty + tri_h), (tx + tri_w, ty + tri_h / 2)],
        fill=ACCENT,
    )
    return img


def main() -> None:
    base = draw_icon(256)
    base.save("build/icon.ico", sizes=[(s, s) for s in SIZES], append_images=[])
    base.save("build/icon-preview.png")
    base.save("build/icon.png")
    print("wrote build/icon.ico, build/icon.png, build/icon-preview.png")

    # Sanity check: the .ico must contain the sizes Windows asks for.
    ico = Image.open("build/icon.ico")
    print("ico sizes:", sorted(ico.info.get("sizes", [])))


if __name__ == "__main__":
    main()
