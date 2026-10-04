@echo off
rem Double-click start: builds first if needed, then serves web\dist and opens the browser.
rem Close this window to stop the server.
setlocal
cd /d "%~dp0web"
if not exist "dist\index.html" call "%~dp0build.bat" nopause || exit /b 1
set "PAGE=/?src=samples/showcase.usda"
if not exist "dist\core\usdcore.wasm" set "PAGE=/?core=mock-core/&src=mock.usda"
call npm run preview -- --open "%PAGE%"
pause
