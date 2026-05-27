#!/usr/bin/env python3
from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageDraw


ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "Source" / "assets" / "cloud-figure.png"


def main() -> int:
    OUT.parent.mkdir(parents=True, exist_ok=True)
    width, height = 128, 80
    image = Image.new("RGBA", (width, height), (255, 255, 255, 0))
    draw = ImageDraw.Draw(image)

    draw.rectangle((0, 0, width - 1, height - 1), fill=(255, 255, 255, 255))
    draw.rectangle((0, 0, width - 1, height - 1), outline=(0, 0, 0, 255))
    draw.line((0, 18, width - 1, 18), fill=(0, 0, 0, 255))
    draw.text((8, 5), "nteract", fill=(0, 0, 0, 255))

    for x in range(8, 120, 8):
        draw.line((x, 28, x, 70), fill=(0, 0, 0, 255))
    for y in range(28, 71, 8):
        draw.line((8, y, 120, y), fill=(0, 0, 0, 255))

    bars = [18, 46, 74, 102]
    heights = [18, 34, 26, 40]
    patterns = [
        lambda x, y: True,
        lambda x, y: (x + y) % 2 == 0,
        lambda x, y: x % 4 in (0, 1),
        lambda x, y: (x - y) % 6 in (0, 1, 2),
    ]
    for left, bar_height, pattern in zip(bars, heights, patterns):
        top = 68 - bar_height
        for x in range(left, left + 14):
            for y in range(top, 68):
                if pattern(x, y):
                    image.putpixel((x, y), (0, 0, 0, 255))

    for y in range(height):
        for x in range(width):
            red, green, blue, alpha = image.getpixel((x, y))
            if alpha == 0:
                continue
            luminance = (red + green + blue) // 3
            image.putpixel((x, y), (0, 0, 0, 255) if luminance < 240 else (255, 255, 255, 255))

    image.save(OUT)
    print(f"generated={OUT}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
