#!/usr/bin/env python3
"""Render the established TabMonger vector mark as extension PNG icons."""

from pathlib import Path

from PIL import Image, ImageDraw


ROOT = Path(__file__).resolve().parents[1]
ICON_DIR = ROOT / "source" / "icons"
SCALE = 8


def point(value: float) -> int:
    return round(value * SCALE)


def render(size: int) -> None:
    canvas = Image.new("RGBA", (64 * SCALE, 64 * SCALE), (0, 0, 0, 0))
    draw = ImageDraw.Draw(canvas)
    draw.rounded_rectangle(
        (point(3), point(3), point(61), point(61)),
        radius=point(15),
        fill="#101722",
        outline="#52698f",
        width=point(2),
    )
    draw.line((point(4), point(19), point(60), point(19)), fill="#52698f", width=point(2))
    for center, color in (((13, 11), "#edf2fb"), ((20, 11), "#7f96c9"), ((27, 11), "#52698f")):
        x, y = center
        draw.ellipse((point(x - 2.2), point(y - 2.2), point(x + 2.2), point(y + 2.2)), fill=color)
    draw.polygon(
        [
            (point(10), point(24)), (point(21), point(24)), (point(32), point(33)),
            (point(43), point(24)), (point(54), point(24)), (point(54), point(55)),
            (point(42), point(55)), (point(42), point(38)), (point(32), point(46)),
            (point(22), point(38)), (point(22), point(55)), (point(10), point(55)),
        ],
        fill="#edf2fb",
    )
    draw.rounded_rectangle((point(27), point(42), point(37), point(47)), radius=point(1.5), fill="#7f96c9")
    draw.rounded_rectangle((point(27), point(49), point(31), point(53)), radius=point(1), fill="#52698f")
    draw.rounded_rectangle((point(33), point(49), point(37), point(53)), radius=point(1), fill="#101722")
    icon = canvas.resize((size, size), Image.Resampling.LANCZOS)
    icon.save(ICON_DIR / f"icon-{size}.png", optimize=True)


ICON_DIR.mkdir(parents=True, exist_ok=True)
for icon_size in (16, 32, 48, 128):
    render(icon_size)
print("Rendered TabMonger extension icons at 16, 32, 48, and 128 pixels.")
