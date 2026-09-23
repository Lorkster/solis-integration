"""Renders both widgets in light and dark mode and writes the 1024x1024 widget preview images.

Usage: python tools/widget-preview/make-previews.py   (needs Node and Microsoft Edge)
"""
import subprocess
from pathlib import Path

from PIL import Image

HERE = Path(__file__).parent
WIDGETS = HERE.parent.parent / "homey-app" / "widgets"
BACKGROUND = {"light": (242, 242, 247), "dark": (0, 0, 0)}

for widget, height in (("battery-plan", 780), ("battery-status", 460)):
    for theme in ("light", "dark"):
        shot = HERE / f"{widget}-{theme}.png"
        subprocess.run(["node", str(HERE / "render.mjs"), widget, theme, "384", str(height), str(shot)], check=True, capture_output=True)
        img = Image.open(shot).convert("RGB")
        # Crop to the widget card: 2x scale, 384 px wide card, trim empty space below.
        bg = BACKGROUND[theme]
        bottom = img.height
        while bottom > 0 and all(img.getpixel((x, bottom - 1)) == bg for x in range(0, 768, 16)):
            bottom -= 1
        card = img.crop((0, 0, 768, min(img.height, bottom + 24)))
        scale = min(1, 960 / card.height, 960 / card.width)
        card = card.resize((round(card.width * scale), round(card.height * scale)), Image.LANCZOS)
        canvas = Image.new("RGB", (1024, 1024), bg)
        canvas.paste(card, ((1024 - card.width) // 2, (1024 - card.height) // 2))
        canvas.save(WIDGETS / widget / f"preview-{theme}.png", optimize=True)
        print(WIDGETS / widget / f"preview-{theme}.png")
