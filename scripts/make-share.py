# Makes the link preview picture (website/share.png, 1200 x 630) that WhatsApp, social media and search show for
# every page of the website: the logo on a clean light background, the first line of the tagline and the address.
# Re-run it when the logo, the tagline or the address changes (python scripts/make-share.py), then look at the picture.
# The words come from website/site.config.json, so a rename is still one edit there plus this.
import json
import os
from PIL import Image, ImageDraw, ImageFilter, ImageFont

W, H = 1200, 630
OUT = 'website/share.png'
BG = (251, 251, 253)          # the website's light background
INK = (11, 38, 57)            # the navy of "StudyBridge" in the logo
MUTED = (110, 110, 115)
ACCENT = (0, 122, 136)        # the website's teal
# Soft colour behind, like the website's flowing background: teal top left, gold top right, blue and green below
GLOWS = (((-120, -260, 620, 380), (179, 222, 211)), ((760, -240, 1400, 330), (240, 215, 166)),
         ((-200, 400, 520, 900), (195, 215, 242)), ((720, 380, 1420, 920), (189, 232, 207)))

# The system's own type, as on the website: Segoe UI on Windows, then the usual Mac and Linux fonts
FONTS = {
    'bold': ['C:/Windows/Fonts/segoeuib.ttf', '/System/Library/Fonts/Supplemental/Arial Bold.ttf', '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf'],
    'semibold': ['C:/Windows/Fonts/seguisb.ttf', '/System/Library/Fonts/Supplemental/Arial Bold.ttf', '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf'],
    'regular': ['C:/Windows/Fonts/segoeui.ttf', '/System/Library/Fonts/Supplemental/Arial.ttf', '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'],
}


def font(kind, size):
    for path in FONTS[kind]:
        if os.path.exists(path):
            return ImageFont.truetype(path, size)
    raise SystemExit(f'No {kind} font found: add one to FONTS in scripts/make-share.py')


def centred(draw, y, text, f, fill):
    """Writes one line centred across the picture, with y as the top of its letters."""
    left, top, right, _ = draw.textbbox((0, 0), text, font=f)
    draw.text(((W - (right - left)) / 2 - left, y - top), text, font=f, fill=fill)


def main():
    config = json.load(open('website/site.config.json', encoding='utf-8'))
    line = config['tagline'].split('. ')[0].rstrip('.') + '.'   # "Get exam-ready, step by step."
    address = config['siteUrl'].split('//')[-1].rstrip('/')     # "gostudybridge.com"

    # each glow is its colour laid through a blurred oval (blurring only the oval, so no dark edges creep in)
    pic = Image.new('RGB', (W, H), BG)
    for box, colour in GLOWS:
        mask = Image.new('L', (W, H), 0)
        ImageDraw.Draw(mask).ellipse(box, fill=140)
        pic = Image.composite(Image.new('RGB', (W, H), colour), pic, mask.filter(ImageFilter.GaussianBlur(120)))

    # the logo with its name, 760 wide, in the upper middle
    logo = Image.open('brand/logo-wordmark.png').convert('RGBA')
    lw = 760
    logo = logo.resize((lw, round(logo.height * lw / logo.width)), Image.LANCZOS)
    pic.paste(logo, ((W - lw) // 2, 112), logo)

    d = ImageDraw.Draw(pic)
    centred(d, 348, line, font('bold', 56), INK)
    centred(d, 426, 'IGCSE  ·  A Level  ·  IB Diploma', font('regular', 28), MUTED)
    centred(d, 512, address, font('semibold', 28), ACCENT)

    pic.save(OUT, optimize=True)
    print(f'{OUT}: {W} x {H}, "{line}"')


if __name__ == '__main__':
    main()
