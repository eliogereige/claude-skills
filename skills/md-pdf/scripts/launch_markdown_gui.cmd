@echo off
REM Launch the Markdown -> LaTeX / PDF GUI (tkinter). Double-click or run from cmd.
setlocal
cd /d "%~dp0"
if exist "%~dp0markdown_convert_gui.py" (
  python "%~dp0markdown_convert_gui.py"
) else (
  echo ERROR: markdown_convert_gui.py not found.
  pause
  exit /b 1
)
if errorlevel 1 pause
