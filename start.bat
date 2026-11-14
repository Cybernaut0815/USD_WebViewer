@echo off
rem Double-click start: builds the page (so web\dist is never older than the sources), then serves
rem web\dist and opens the browser. Close this window to stop the server.
rem Port 4180: the browser tests start their own server on 4173 and would reuse one found there.
setlocal
cd /d "%~dp0web"
call "%~dp0build.bat" nopause || exit /b 1
set "PAGE=/?src=samples/showcase.usda"
if not exist "dist\core\usdcore.wasm" set "PAGE=/?core=mock-core/&src=mock.usda"
call npm run preview -- --port 4180 --open "%PAGE%"
pause
