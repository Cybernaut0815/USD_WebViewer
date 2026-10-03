@echo off
rem Builds the wasm SDK. Usage: sdk\build.bat [emsdk dir] [work dir]
rem Defaults: emsdk from %EMSDK%, work dir <repo>\build.
setlocal
set "EMSDK_DIR=%~1"
if "%EMSDK_DIR%"=="" set "EMSDK_DIR=%EMSDK%"
if "%EMSDK_DIR%"=="" (echo Pass the emsdk directory or run emsdk_env.bat first. & exit /b 1)
set "WORK=%~2"
if "%WORK%"=="" for %%I in ("%~dp0..\build") do set "WORK=%%~fI"
call "%EMSDK_DIR%\emsdk_env.bat" >nul 2>&1
rem 16 GB machines run out of memory above this.
set "CMAKE_BUILD_PARALLEL_LEVEL=8"
cmake -S "%~dp0." -B "%WORK%\b" -G Ninja -DSDK_PREFIX=%WORK:\=/%/sdk || exit /b 1
cmake --build "%WORK%\b" || exit /b 1
