# Makes every StudyBridge icon from the logo in brand/ (python3 scripts/make-icons.py)
from PIL import Image, ImageDraw

def load(path):
    im = Image.open(path).convert('RGBA')
    return im.crop(im.getchannel('A').getbbox())

mark = load('brand/logo-mark.png')        # the two figures on the open book
word = load('brand/logo-wordmark.png')    # mark + "StudyBridge"

def fit(im, w, h):
    s = min(w / im.width, h / im.height)
    return im.resize((max(1, round(im.width * s)), max(1, round(im.height * s))), Image.LANCZOS)

def on_square(size, frac, bg=None, radius=0):
    canvas = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    if bg:
        m = Image.new('L', (size, size), 0)
        ImageDraw.Draw(m).rounded_rectangle([0, 0, size - 1, size - 1], radius=radius, fill=255)
        canvas.paste(Image.new('RGBA', (size, size), bg), (0, 0), m)
    lm = fit(mark, size * frac, size * frac)
    # sit the book slightly low so the figures look centred
    canvas.alpha_composite(lm, ((size - lm.width) // 2, (size - lm.height) // 2 + round(size * 0.02)))
    return canvas

def template(size):
    # macOS menu bar: black shape, the system colours it
    im = on_square(size, 0.98)
    black = Image.new('RGBA', im.size, (0, 0, 0, 255))
    black.putalpha(im.getchannel('A'))
    return black

WHITE = (255, 255, 255, 255)
# in the app
fit(mark, 320, 320).save('src/assets/logo-mark.png', optimize=True)
fit(word, 1100, 240).save('src/assets/logo-wordmark.png', optimize=True)
# desktop app icon (Windows, Mac) and installer
on_square(1024, 0.78, WHITE, radius=225).save('build/icon.png')
# tray
on_square(32, 0.98).save('build/tray.png')
template(16).save('build/trayTemplate.png')
template(32).save('build/trayTemplate@2x.png')
# phone / web
on_square(192, 0.82, WHITE).save('public/icon-192.png')
on_square(512, 0.82, WHITE).save('public/icon-512.png')
on_square(512, 0.62, WHITE).save('public/icon-maskable-512.png')
on_square(180, 0.82, WHITE).convert('RGB').save('public/apple-touch-icon.png')
on_square(64, 0.98).save('public/favicon.png')
print('icons written')
