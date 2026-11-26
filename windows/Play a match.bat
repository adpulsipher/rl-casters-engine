@echo off
cd /d "%~dp0"
rem Drop a match file (or a Rocket League .replay) on this file to hear the casters call it.
rem It starts when you press Space, to line it up with a video of the match.
rem With nothing dropped, it plays the newest one: Casters\captures or the matches folder.
if "%~1"=="" goto newest
if /i "%~x1"==".replay" goto convert
"RL Career Casters.exe" --play "%~1" --sync
goto :eof

:convert
call "%~dp0Convert replay.bat" "%~1"
goto :eof

:newest
"RL Career Casters.exe" --play --sync
