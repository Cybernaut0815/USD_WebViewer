@echo off
rem Double-click build: the page's packages, the wasm core when it is missing and emsdk is set up
rem (%EMSDK%, about an hour the first time), then the page into web\dist. start.bat passes nopause.
setlocal
cd /d "%~dp0web"
where npm >nul 2>&1 || (echo Node.js 24+ is needed: https://nodejs.org & goto fail)
call npm install || goto fail
if not exist "public\core\usdcore.wasm" (
  if defined EMSDK (
    call "%~dp0sdk\build.bat" || goto fail
    call "%~dp0native\build.bat" || goto fail
  ) else (
    echo No wasm core in web\public\core and EMSDK is not set: the viewer will run on the mock core.
    echo See README.md, Building the core.
  )
)
call npm run build || goto fail
echo.
echo Built into web\dist. Start it with start.bat.
if not "%~1"=="nopause" pause
exit /b 0

:fail
echo.
echo Build failed.
pause
exit /b 1
