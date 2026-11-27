# Python EXE Build Pipeline — Reference Templates

Detailed templates for each step. Use when implementing the build pipeline.

---

## PyInstaller Spec Template

```python
# -*- mode: python ; coding: utf-8 -*-
from pathlib import Path

spec_dir = Path(SPECPATH).resolve()
runtime_hooks = [
    str(spec_dir / 'pyi_rth_path_fix.py'),    # Paths first
    str(spec_dir / 'pyi_rth_pyarrow_fix.py'), # Module fixes second
]

a = Analysis(
    ['main.py'],
    pathex=[],
    binaries=[],
    datas=[('icon.ico', '.'), ('logo.png', '.'), ('config.txt', '.')],
    hiddenimports=['pyarrow', 'pyarrow.vendored.version'],
    excludes=['matplotlib.backends.backend_qt5', 'scipy', 'torch'],
    runtime_hooks=runtime_hooks,
    optimize=1,  # NOT 2: NumPy crashes with -OO
)
pyz = PYZ(a.pure)
exe = EXE(
    pyz, a.scripts, a.binaries, a.datas, [],
    name='MyApp',
    debug=False,
    strip=False,
    upx=False,
    console=False,
    version='file_version_info.txt',
    icon=['icon.ico'],
    uac_admin=False,
)
```

**Onedir mode** (exe + `_internal/` folder): use `exclude_binaries=True` and `COLLECT()` — list the extra binaries and data files the app needs in `COLLECT()`.

---

## file_version_info.txt Template

```python
# UTF-8
VSVersionInfo(
  ffi=FixedFileInfo(filevers=(1, 0, 0, 0), prodvers=(1, 0, 0, 0),
  mask=0x3f, flags=0x0, OS=0x40004, fileType=0x1, subtype=0x0, date=(0, 0)),
  kids=[
    StringFileInfo([
      StringTable('040904B0', [
        StringStruct('CompanyName', 'Your Company'),
        StringStruct('FileDescription', 'MyApp'),
        StringStruct('FileVersion', '1.0.0.0'),
        StringStruct('ProductName', 'MyApp'),
        StringStruct('ProductVersion', '1.0.0.0')
      ])
    ]),
    VarFileInfo([VarStruct('Translation', [1033, 1200])])
  ]
)
```

---

## Signing Commands (PowerShell)

**Create self-signed certificate:**

```powershell
$cert = New-SelfSignedCertificate `
    -Type CodeSigning `
    -Subject "CN=Your Company - MyApp" `
    -CertStoreLocation "Cert:\CurrentUser\My" `
    -KeyUsage DigitalSignature `
    -KeyAlgorithm RSA `
    -KeyLength 2048 `
    -HashAlgorithm SHA256 `
    -NotAfter (Get-Date).AddYears(5)

$pwd = ConvertTo-SecureString -String "YourPassword" -Force -AsPlainText
Export-PfxCertificate -Cert $cert -FilePath "dist/MyApp_Certificate.pfx" -Password $pwd
```

**Find and run signtool:**

```powershell
$signtool = Get-ChildItem "C:\Program Files*\Windows Kits\10\bin\*\x64\signtool.exe" -ErrorAction SilentlyContinue | Select-Object -First 1
& $signtool.FullName sign /fd sha256 /f "dist/MyApp_Certificate.pfx" /p "YourPassword" /tr "http://timestamp.digicert.com" /td sha256 "dist/MyApp.exe"
```

**Export .cer for distribution (optional):**

```powershell
$pwd = ConvertTo-SecureString -String "YourPassword" -Force -AsPlainText
$cert = Import-PfxCertificate -FilePath "dist/MyApp_Certificate.pfx" -CertStoreLocation "Cert:\CurrentUser\My" -Password $pwd -Exportable
Export-Certificate -Cert $cert -FilePath "dist/MyApp_Certificate.cer" -Type CERT
```

---

## Inno Setup Template (script_for_setup.iss)

Use relative paths. Replace `{{GENERATE-NEW-GUID}}` with a GUID (Tools → Generate GUID in Inno Setup).

```iss
#define MyAppName "MyApp"
#define MyAppVersion "1.0.0"
#define MyAppPublisher "Your Company"
#define MyAppExeName "MyApp.exe"

[Setup]
AppId={{GENERATE-NEW-GUID}}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
DefaultDirName={autopf}\MyApp
UninstallDisplayIcon={app}\{#MyAppExeName}
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
DisableProgramGroupPage=yes
LicenseFile=license.txt
PrivilegesRequired=lowest
OutputDir=setup
OutputBaseFilename=setup
SetupIconFile=icon.ico
SolidCompression=yes
WizardStyle=modern

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"; Flags: unchecked

[Files]
; Onefile: exe at dist/MyApp.exe. Onedir: exe at dist/MyApp/MyApp.exe — copy whole dist/MyApp/ with recursesubdirs
Source: "dist/{#MyAppExeName}"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{autoprograms}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; Tasks: desktopicon

[Run]
Filename: "{app}\{#MyAppExeName}"; Description: "{cm:LaunchProgram,{#StringChange(MyAppName, '&', '&&')}}"; Flags: nowait postinstall skipifsilent
```

---

## BUILD.ps1 / build_exe.ps1 Template

```powershell
# 1. PyInstaller
pyinstaller "MyApp.spec"
if ($LASTEXITCODE -ne 0) { exit 1 }

# 2. Create cert if missing
$pfx = "dist/MyApp_Certificate.pfx"
if (-not (Test-Path $pfx)) {
    $cert = New-SelfSignedCertificate -Type CodeSigning -Subject "CN=Your Company - MyApp" -CertStoreLocation "Cert:\CurrentUser\My" -NotAfter (Get-Date).AddYears(5)
    Export-PfxCertificate -Cert $cert -FilePath $pfx -Password (ConvertTo-SecureString "YourPassword" -Force -AsPlainText)
}

# 3. Sign
$signtool = Get-ChildItem "C:\Program Files*\Windows Kits\10\bin\*\x64\signtool.exe" -ErrorAction SilentlyContinue | Select-Object -First 1
if ($signtool) {
    & $signtool.FullName sign /fd sha256 /f $pfx /p "YourPassword" /tr "http://timestamp.digicert.com" /td sha256 "dist/MyApp.exe"
}
```

---

## build_exe.bat Template

Wrapper for double-click or non-PowerShell environments. Place next to build_exe.ps1.

```batch
@echo off
powershell.exe -ExecutionPolicy Bypass -File "%~dp0build_exe.ps1" %*
```

---

## Runtime Hook: Path Fix (pyi_rth_path_fix.py)

Runs before main script. Add DLL dirs, sys.path, and config env vars.

```python
import os
import sys
from pathlib import Path

if hasattr(sys, '_MEIPASS'):
    bundle_dir = Path(sys._MEIPASS)
    internal_dir = bundle_dir / '_internal' if (bundle_dir / '_internal').exists() else bundle_dir
    parent_dir = bundle_dir.parent if (bundle_dir / '_internal').exists() else bundle_dir

    # Add DLL directories (Python 3.8+)
    for base in [bundle_dir, parent_dir, internal_dir]:
        for sub in ['vendor/dll', 'vendor/python/dll']:
            d = base / sub
            if d.exists() and hasattr(os, 'add_dll_directory'):
                os.add_dll_directory(str(d))

    # Config file: set env var so app finds it
    for p in [bundle_dir / 'config.txt', internal_dir / 'config.txt', parent_dir / 'config.txt']:
        if p.exists():
            os.environ['CONFIG_PATH'] = str(p)
            break
```

---

## Runtime Hook: PyArrow Fix (pyi_rth_pyarrow_fix.py)

Fixes `AttributeError: module 'pyarrow' has no attribute '__version__'` after Inno Setup install.

```python
import sys
try:
    import pyarrow
    if not hasattr(pyarrow, '__version__'):
        try:
            from importlib.metadata import version
            pyarrow.__version__ = version('pyarrow')
        except Exception:
            pyarrow.__version__ = '0.0.0'
except ImportError:
    pass
```

---

## Vendor SDK Patching Pattern

When a vendor SDK uses `__file__` for DLL paths, create a patched copy:

```python
# Patched SDK (e.g. vendor_sdk.py)
import os, sys

if getattr(sys, 'frozen', False) and hasattr(sys, '_MEIPASS'):
    _BASE_DIR = sys._MEIPASS
    _DLL_DIR = os.path.join(_BASE_DIR, 'vendor/dll')
else:
    _THIS_DIR = os.path.dirname(os.path.abspath(__file__))
    _DLL_DIR = os.path.abspath(os.path.join(_THIS_DIR, '..', 'dll'))

# Then load DLL from _DLL_DIR
```

Bundle the patched file via `datas`, not `hiddenimports`:

```python
datas.append((str(patched_sdk_path), 'vendor/python'))
```

---

## Config Path Resolution (App Code)

```python
def _get_config_path():
    # 1. Env override
    p = os.environ.get('CONFIG_PATH')
    if p and os.path.exists(p):
        return p
    # 2. Bundle (frozen)
    if getattr(sys, 'frozen', False):
        b = os.path.join(sys._MEIPASS, 'config.txt')
        if os.path.exists(b):
            return b
    # 3. Script dir
    s = os.path.join(os.path.dirname(__file__), 'config.txt')
    if os.path.exists(s):
        return s
    # 4. Dev fallback
    return '/absolute/dev/path/config.txt'
```

---

## Debugging Checklist

| Step | If fails here |
|------|----------------|
| 1. `python app.py` | Not a bundling issue |
| 2. `dist\MyApp\MyApp.exe` | Bundling: paths, hiddenimports, datas |
| 3. Installed app (Inno Setup) | Relocation: pyarrow `__version__`, metadata |

**Common fixes:** DLL not found → `os.add_dll_directory()` in hook. Vendor SDK fails → patch + `datas`. `__version__` error → version-fix hook. Works in dist\ but not installed → add pyarrow/pandas version hook.
