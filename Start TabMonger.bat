@echo off
setlocal
cd /d "%~dp0"

set "TM_HOST=0.0.0.0"
set "TM_PORT=8787"
if not "%TABMONGER_HOST%"=="" set "TM_HOST=%TABMONGER_HOST%"
if not "%TABMONGER_PORT%"=="" set "TM_PORT=%TABMONGER_PORT%"

echo.
echo Starting TabMonger for this PC and your private local network...
echo Windows may ask for network access the first time. Allow Private networks only.

where py >nul 2>nul
if %errorlevel%==0 goto run_with_py

where python >nul 2>nul
if %errorlevel%==0 goto run_with_python

goto python_missing

:run_with_py
py -3 -c "import sys; sys.exit(0 if sys.version_info ^>= (3, 10) else 1)"
if errorlevel 1 goto run_with_python
py -3 server.py --host "%TM_HOST%" --port "%TM_PORT%" --find-port --open %*
set "TM_EXIT=%errorlevel%"
goto finished

:run_with_python
python -c "import sys; sys.exit(0 if sys.version_info ^>= (3, 10) else 1)"
if errorlevel 1 goto python_missing
python server.py --host "%TM_HOST%" --port "%TM_PORT%" --find-port --open %*
set "TM_EXIT=%errorlevel%"
goto finished

:python_missing
echo.
echo TabMonger needs Python 3.10 or newer, but a compatible Python was not found.
echo Install the current Python 3 from python.org, then double-click this file again.
echo During setup, select "Add python.exe to PATH".
pause
exit /b 1

:finished
if not "%TM_EXIT%"=="0" pause
