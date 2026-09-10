import cairosvg
from PIL import Image

# 生成高分辨率 PNG
cairosvg.svg2png(url="pyshell.svg", write_to="pyshell_1024.png",
                 output_width=1024, output_height=1024)

img = Image.open("pyshell_1024.png").convert("RGBA")

# 保存多尺寸 ICO
img.save("pyshell.ico",
         sizes=[(16, 16), (24, 24), (32, 32), (48, 48),
                (64, 64), (128, 128), (256, 256)])