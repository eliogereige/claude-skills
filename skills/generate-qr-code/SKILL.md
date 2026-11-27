---
name: generate-qr-code
description: >-
  Generate a stylized, scannable QR code from a URL or any text and save it as
  PNG or WEBP. Use whenever the user asks to generate / create / make / build a
  QR code (or "QR", "qrcode") — for a link, WiFi, vCard, plain text, etc.
  Supports color themes, gradients, custom foreground/background colors,
  rounded/dotted/circle/bar module shapes, an embedded center logo or
  full-canvas artistic logo, custom finder "eye" colors, and transparent
  backgrounds. Runs headless (no GUI); works in any project or directory.
---

# Generate QR Code

Create a branded, scannable QR code from the command line. The generator is a
single self-contained Python script — it does **not** depend on any project and
only needs the packages `qrcode[pil]` and `Pillow`.

## When to use

Trigger on any request to make a QR code, e.g. "generate a QR code for
https://…", "make a QR for our WiFi", "create a branded QR with our logo",
"qr code for this text". Pick sensible styling from the request (brand colors,
logo, theme) and run the script — don't ask for details you can infer.

## Requirements

```bash
pip install "qrcode[pil]" Pillow
```

`validators` is used if installed (better URL detection) but is optional.

## Quick start

```bash
python "<SKILL_DIR>/scripts/generate_qr.py" "https://example.com" -o qr.png
```

`<SKILL_DIR>` is the folder containing this SKILL.md
(this skill's base directory). Always pass an absolute `-o` output path
(or one relative to the user's working directory) so the file lands where the
user expects. Report the saved path back to the user.

If the input is not URL-shaped it is encoded as raw text automatically; pass
`--raw` to force verbatim encoding (WiFi strings, vCards, arbitrary payloads).

## Common recipes

```bash
# Branded QR with a centered logo (error correction auto-forced to H)
python .../generate_qr.py "example.com" -o brand.png --logo logo.png

# Artistic: logo fills the whole canvas, modules drawn on top
python .../generate_qr.py "example.com" -o hero.png --logo logo.png --logo-background

# Themed with rounded dots
python .../generate_qr.py "example.com" -o ocean.png --theme ocean --module rounded

# Custom brand colors + colored finder "eyes" + dotted modules
python .../generate_qr.py "example.com" -o custom.png \
  --front "#00335b" --back "#fdfdf5" --eye-color "#e6c164" --module dotted

# Transparent background, high-res WEBP
python .../generate_qr.py "example.com" -o qr.webp --transparent --box-size 20

# WiFi payload (raw), and list all themes
python .../generate_qr.py "WIFI:S:MyNet;T:WPA;P:secret;;" -o wifi.png --raw
python .../generate_qr.py --list-themes
```

## Options

| Flag | Values / default | Purpose |
|------|------------------|---------|
| `data` (positional) | URL or text | Content to encode. Required unless `--list-themes`. |
| `-o, --output` | path (`qr.png`) | Output file; `.webp` → WEBP, else PNG. |
| `--theme` | see `--list-themes` (`branded`) | Color/style preset. |
| `--module` | `square` `rounded` `dotted` `circle` `horizontal_bars` `vertical_bars` | Module (dot) shape. |
| `--error-correction` | `M` `Q` `H` (`H`) | Redundancy; auto-forced to `H` when a logo is used. |
| `--front` / `--back` | `#rrggbb` | Override foreground / background color. |
| `--gradient` | `none` `radial` `horizontal` `vertical` `square` | Gradient type override. |
| `--gradient-end` | `#rrggbb` | Gradient end color. |
| `--logo` | path | Embed a centered logo (~15% of QR). |
| `--logo-background` | flag | Logo fills the canvas; modules drawn on top (artistic). |
| `--logo-backdrop` | `rounded` `circle` `square` `none` (`rounded`) | Shape of the patch behind a centered logo. |
| `--eye-color` / `--eyeball-color` | `#rrggbb` | Recolor finder frames / centers. |
| `--transparent` | flag | Transparent background. |
| `--box-size` | int (`12`) | Pixels per module → resolution. |
| `--border` | int (`4`) | Quiet-zone width in modules (keep ≥ 4). |
| `--format` | `PNG` `WEBP` | Force output format. |
| `--raw` | flag | Skip URL normalization; encode verbatim. |
| `--list-themes` | flag | Print themes and exit. |

## Scannability notes

The script protects legibility automatically, but keep these in mind:

- **Contrast**: a safety net darkens the foreground / lightens the background if
  both are too light or too dark, but strong contrast (dark on light) scans best.
- **Logos**: use only with error correction `H` or `Q` (auto-enforced). The logo
  is capped at ~18% of the QR so data stays readable.
- **Quiet zone**: keep `--border` at 4+; finder patterns are always drawn solid
  for reliability even in artistic/dotted modes.
- **Resolution**: bump `--box-size` (e.g. 16–20) for print or large displays.
- After generating, it's good practice to open the image and confirm it scans.
