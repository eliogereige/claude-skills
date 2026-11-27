# Credits and prior art

- **`mods/blast-radius`, `mods/token-weather`** — same names and core ideas as the example mods in
  [anthropics/claude-code-playground](https://github.com/anthropics/claude-code-playground) (Apache-2.0).
  The code here is an independent implementation (no copied code beyond the mod API's standard boilerplate) with a different scope.
- **`skills/markitdown`** — a wrapper around [microsoft/markitdown](https://github.com/microsoft/markitdown) (MIT),
  which it calls as a library; markitdown itself is not included.
- **Plugin icons** (`.claude-plugin/icon.png`) — the icons of `garde-fou`, `outbound-guard`, `git-commit-push` and
  `agent-tree` were generated with Google Gemini and then edited (colour palette, rounded transparent corners); the
  other four were drawn for this repository from simple shapes.

## Dependencies (installed separately, not included in this repository)

| Used by | Dependency | License |
|---|---|---|
| `md-pdf` | [PyMuPDF](https://github.com/pymupdf/PyMuPDF) | AGPL-3.0, or Artifex commercial license |
| `md-pdf` | ReportLab | BSD |
| `md-pdf` | matplotlib | matplotlib license (PSF-based) |
| `md-pdf` | Pillow | MIT-CMU |
| `md-pdf` | MiKTeX or TeX Live (optional, for the LaTeX route) | their own free-software terms |
| `markitdown` | markitdown | MIT |
| `gemini` | Antigravity CLI | Google's terms |
| `python-exe-build-pipeline` | PyInstaller, Inno Setup | their own terms |

This repository's code is MIT-licensed and only imports these packages. If you redistribute `md-pdf` together with
PyMuPDF, or offer it as a network service, PyMuPDF's AGPL-3.0 terms apply to that combination. This note is
informational, not legal advice.
