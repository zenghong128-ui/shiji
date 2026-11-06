"""Draw original project artwork; no personal screenshots or third-party imagery."""

from pathlib import Path
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[1]


def main():
    folder = ROOT / "docs" / "images"
    folder.mkdir(parents=True, exist_ok=True)
    image = Image.new("RGBA", (256, 256), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    draw.rounded_rectangle((0, 0, 255, 255), 60, fill="#3567c8")
    draw.rounded_rectangle((65, 45, 195, 211), 22, fill="white")
    for y, end in [(90, 160), (123, 160), (156, 135)]:
        draw.line((95, y, end, y), fill="#3567c8", width=12)
    draw.ellipse((139, 139, 238, 238), fill="#cce1ff", outline="#3567c8", width=8)
    draw.line([(163, 188), (183, 208), (215, 166)], fill="#3567c8", width=10)
    image.save(
        folder / "shiji.ico",
        sizes=[(16, 16), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)],
    )


if __name__ == "__main__":
    main()
