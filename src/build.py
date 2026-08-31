#!/usr/bin/env python3
"""Bundle three.js + game.js into a single self-contained gta-topdown.html"""
import pathlib

ROOT = pathlib.Path(__file__).parent
OUT = pathlib.Path('/home/user/gta-topdown.html')

html = (ROOT / 'index.template.html').read_text()
three = (ROOT / 'three.min.js').read_text()
game = (ROOT / 'game.js').read_text()

# drop the sourcemap reference (it 404s when inlined)
three = '\n'.join(l for l in three.splitlines() if 'sourceMappingURL' not in l)

assert '</script>' not in three, 'three.min.js would break inline embedding'
assert '</script>' not in game, 'game.js would break inline embedding'

html = html.replace('/*__THREE__*/', three, 1)
html = html.replace('/*__GAME__*/', game, 1)

OUT.write_text(html)
print(f'built {OUT} ({len(html)/1024:.0f} KB)')
