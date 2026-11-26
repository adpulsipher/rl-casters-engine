@echo off
setlocal EnableExtensions
cd /d "%~dp0"
title Convert a Rocket League replay
echo.
if "%~1"=="" goto usage
if /i not "%~x1"==".replay" goto usage
if not exist "%~1" goto usage
if not exist "converter\replay2stream.py" goto noconverter
if not exist "matches" mkdir "matches"
set "OUT=%~dp0matches"
set "CONV=%~dp0converter\replay2stream.py"
rem The replay reader is only made for x64 Windows. On an ARM PC it runs in
rem x64 Python, which Windows emulates; uv sets that up on its own.
set "ARM="
if /i "%PROCESSOR_ARCHITECTURE%"=="ARM64" set "ARM=1"
if /i "%PROCESSOR_ARCHITEW6432%"=="ARM64" set "ARM=1"

where uv >nul 2>nul
if not errorlevel 1 goto with_uv
if defined ARM goto needuv
where py >nul 2>nul
if not errorlevel 1 goto with_py
goto needuv

:with_uv
echo  Converting "%~nx1"...
echo  The first time, this downloads Python and the replay reader (about 60 MB).
echo.
uv run --quiet --no-project --python cpython-3.12-windows-x86_64-none --with subtr-actor-py==1.5.1 --with numpy python "%CONV%" "%~1" "%OUT%" >nul
if errorlevel 1 goto failed
goto play

:with_py
py -3 -c "import subtr_actor, numpy" >nul 2>nul
if not errorlevel 1 goto py_ready
echo  Installing the replay reader for Python (about 30 MB, first time only)...
py -3 -m pip install --quiet --user --only-binary=:all: subtr-actor-py==1.5.1 numpy
py -3 -c "import subtr_actor, numpy" >nul 2>nul
if errorlevel 1 goto needuv
:py_ready
echo  Converting "%~nx1"...
echo.
py -3 "%CONV%" "%~1" "%OUT%" >nul
if errorlevel 1 goto failed
goto play

:play
echo  Saved as matches\%~n1.jsonl.gz (drop it on "Play a match.bat" to hear it again).
echo.
"RL Career Casters.exe" --play "%OUT%\%~n1.jsonl.gz" --sync
goto done

:usage
echo  Drag a Rocket League replay (a .replay file) onto this file. It becomes a
echo  match the casters can play, then they call it.
echo  Your saved replays are in  Documents\My Games\Rocket League\TAGame\Demos
echo  To save one: after a match, choose Save Replay.
echo.
pause
goto done

:noconverter
echo  The converter folder is missing. Unzip the whole RL Career Casters zip
echo  into this folder again, then try again.
echo.
pause
goto done

:needuv
echo.
echo  Reading replays on this PC needs uv (a small Python tool manager).
echo  To install it, open PowerShell and run:
echo      winget install --id astral-sh.uv -e
echo  Then close this window and drop the replay on "Play a match.bat" again.
echo.
pause
goto done

:failed
echo.
echo  The replay reader could not read this replay. It may be from a newer
echo  Rocket League version than the reader knows.
echo.
pause
goto done

:done
endlocal
