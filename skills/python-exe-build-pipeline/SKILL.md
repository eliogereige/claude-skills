---
name: python-exe-build-pipeline
description: Build Windows .exe from Python scripts using PyInstaller, add icons, sign with code-signing certificates, and create Inno Setup installers. Use when packaging a Python app as an executable, creating a Windows installer, signing an application, or setting up a build pipeline for distribution.
---

# Python EXE Build Pipeline

Guides building a Windows executable from a Python script, adding icons, code signing, and creating a setup installer.

## Workflow Checklist

```
Task Progress:
- [ ] Step 1: Build EXE with PyInstaller
- [ ] Step 2: Add icon and version metadata
- [ ] Step 3: Sign the executable
- [ ] Step 4: Create Inno Setup installer
```

---

## Quick Start

**Prerequisites:** Python 3.x, `pip install pyinstaller`, Windows. Optional: Windows SDK (signtool), Inno Setup.

### Step 1: Build EXE

```bash
pyinstaller "MyApp.spec"
```

Output: `dist/MyApp.exe` (onedir) or `dist/MyApp.exe` (onefile)

**Spec essentials:** `upx=False` (reduces AV false positives), `uac_admin=False`, `icon=['icon.ico']`, `datas` for bundled assets. Use `optimize=1` (not 2) — NumPy and others can crash with `-OO`.

### Step 2: Icon and Version

- Place `icon.ico` in project root; reference in spec: `icon=['icon.ico']`
- Optional: create `file_version_info.txt` for Windows file properties; reference in spec: `version='file_version_info.txt'`

### Step 3: Sign (optional)

1. Create self-signed cert → export PFX to `dist/`
2. Sign with signtool: `signtool sign /fd sha256 /f cert.pfx /p password /tr http://timestamp.digicert.com /td sha256 dist/MyApp.exe`

### Step 4: Setup Installer

Create `script_for_setup.iss` with relative paths (`license.txt`, `icon.ico`, `dist/MyApp.exe`). Build:

```bash
"C:\Program Files (x86)\Inno Setup 6\ISCC.exe" script_for_setup.iss
```

Output: `setup/setup.exe`

---

## Runtime Asset Paths

In Python, resolve bundled assets for both dev and PyInstaller:

```python
import os, sys
def get_asset_path(name: str) -> str:
    base = getattr(sys, "_MEIPASS", os.path.dirname(os.path.abspath(__file__)))
    return os.path.join(base, name)
```

**Config files:** Prefer env var → bundle (`sys._MEIPASS`) → script dir → dev fallback. Never hardcode absolute paths.

---

## Vendor SDKs and DLLs

**Critical:** Vendor SDKs that use `__file__` for DLL paths break when bundled. Patch them:

```python
if getattr(sys, 'frozen', False) and hasattr(sys, '_MEIPASS'):
    _BASE_DIR = sys._MEIPASS
    _DLL_DIR = os.path.join(_BASE_DIR, 'vendor/dll')
else:
    _THIS_DIR = os.path.dirname(os.path.abspath(__file__))
    _DLL_DIR = os.path.abspath(os.path.join(_THIS_DIR, '..', 'dll'))
```

- Bundle the **patched** SDK via `datas`, not `hiddenimports` — so `__file__` resolves correctly.
- Add a **runtime hook** that runs first: call `os.add_dll_directory()` for every DLL candidate path before any imports.
- Check multiple candidate paths (bundle root, `_internal`, parent) — PyInstaller layout varies.

---

## hiddenimports vs datas

| Use `hiddenimports` | Use `datas` (NOT hiddenimports) |
|---------------------|----------------------------------|
| Standard modules PyInstaller misses | Vendor SDKs that use `__file__` for paths |
| Dynamically imported modules | Config files, assets, DLLs |
| `pyarrow`, `pyarrow.vendored.version` | Any file needing correct filesystem location |

**Never** list a vendor SDK in both — it gets bundled twice with wrong `__file__` and DLL loading fails.

---

## Runtime Hooks

Order matters: path setup first, then module patches.

```python
runtime_hooks = [
    'pyi_rth_path_fix.py',   # os.add_dll_directory(), sys.path, env vars
    'pyi_rth_pyarrow_fix.py', # Fix pyarrow.__version__ if missing
]
```

Packages like pyarrow can lose `__version__` after install; patch in a hook:

```python
if not hasattr(pyarrow, '__version__'):
    pyarrow.__version__ = version('pyarrow')  # or '0.0.0' fallback
```

---

## Testing Strategy

**Exe from `dist\` can work while the installed app fails.** Test all three:

1. **Source** — `python app.py`
2. **PyInstaller output** — `dist\MyApp\MyApp.exe`
3. **Installed app** — Run Inno Setup installer and launch

Stage 1→2: bundling (paths, missing files). Stage 2→3: relocation, metadata (e.g. pyarrow `__version__`).

---

## File Checklist

| File | Purpose |
|------|---------|
| `main.py` | Entry script |
| `MyApp.spec` | PyInstaller config |
| `pyi_rth_*.py` | Runtime hooks (path fix, module patches) |
| `file_version_info.txt` | Windows version metadata (optional) |
| `icon.ico` | EXE and setup icon |
| `license.txt` | Shown during install |
| `build_exe.ps1` / `BUILD.ps1` | Automated build (PyInstaller + sign) |
| `build_exe.bat` | Wrapper for double-click build (calls .ps1) |
| `script_for_setup.iss` | Inno Setup script |
| `requirements.txt` | pyinstaller, app deps |


---

## Troubleshooting

- **pyinstaller not found**: `pip install pyinstaller`
- **signtool not found**: Install Windows SDK; signing is optional
- **AV false positives**: Use `upx=False`, `uac_admin=False`
- **Missing imports**: Add to `hiddenimports` in spec
- **DLL not found**: Add `os.add_dll_directory()` in runtime hook; check multiple candidate paths
- **Vendor SDK fails**: Patch to use `sys._MEIPASS` when frozen; bundle via `datas`, not `hiddenimports`
- **AttributeError: __version__**: Add runtime hook to set `module.__version__`
- **Works in dist\ but not installed**: Often pyarrow/pandas metadata; add version-fix hook
- **Inno Setup paths**: Use paths relative to .iss file for portability

---

## Additional Resources

- For full templates (spec, version info, signing commands, Inno Setup, BUILD.ps1, runtime hooks), see [reference.md](reference.md)
