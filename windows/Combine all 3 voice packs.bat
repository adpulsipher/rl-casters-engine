@echo off
setlocal EnableExtensions
cd /d "%~dp0"
title Combine all 3 voice packs
echo.
echo  Combine all 3 voice packs into one
echo  ----------------------------------
echo  Your main pack, the 1.4 add-on and the 2.0 add-on become one pack zip.
echo  Nothing is deleted or changed: the combined pack is a new zip next to them.
echo.

if not exist "RL Career Casters.exe" goto noexe

set "MAIN="
set "A14="
set "A20="
set "OTHER=0"
for %%F in ("*.zip" "Casters\*.zip") do call :sort "%%~nxF"

echo  Found next to RL Career Casters.exe:
call :show "main pack " MAIN
call :show "1.4 add-on" A14
call :show "2.0 add-on" A20
if not "%OTHER%"=="0" echo    plus %OTHER% other add-on zip^(s^)
echo.

set "MISSING="
if not defined MAIN set "MISSING=1"
if not defined A14 set "MISSING=1"
if not defined A20 set "MISSING=1"
if not defined MISSING goto run

echo  Not all 3 are here. Put the missing zip next to RL Career Casters.exe
echo  and run this again, or press Y to combine what's here anyway.
echo  If you already combined the 1.4 add-on before, Y is fine.
echo.
choice /c YN /n /m " Combine anyway? [Y/N] "
if errorlevel 2 goto cancelled

:run
echo  Combining. A pack this size takes a minute or two...
echo.
"RL Career Casters.exe" --combine
goto done

:noexe
echo  This file has to sit next to RL Career Casters.exe.
echo  Move it into your RL Career Casters folder and run it again.
echo.
pause
goto done

:cancelled
echo.
echo  Nothing was changed.
echo.
pause
goto done

:sort
set "NAME=%~1"
echo "%NAME%" | findstr /i /c:"Voice Pack" >nul || goto :eof
echo "%NAME%" | findstr /i /c:"add-on" >nul && goto sort_addon
set "MAIN=%NAME%"
goto :eof
:sort_addon
echo "%NAME%" | findstr /i /c:"add-on 2026-11-24" >nul && goto is14
echo "%NAME%" | findstr /i /c:"add-on 2026-11-26" >nul && goto is20
set /a OTHER+=1
goto :eof
:is14
set "A14=%NAME%"
goto :eof
:is20
set "A20=%NAME%"
goto :eof

:show
setlocal EnableDelayedExpansion
if defined %~2 (echo    found    %~1  !%~2!) else (echo    MISSING  %~1)
endlocal
goto :eof

:done
endlocal
