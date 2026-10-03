@echo off
rem Builds the wasm core against the SDK. Usage: native\build.bat [emsdk dir] [work dir] [Release|Debug]
rem Defaults: emsdk from %EMSDK%, work dir <repo>\build.
setlocal
set "EMSDK_DIR=%~1"
if "%EMSDK_DIR%"=="" set "EMSDK_DIR=%EMSDK%"
if "%EMSDK_DIR%"=="" (echo Pass the emsdk directory or run emsdk_env.bat first. & exit /b 1)
set "WORK=%~2"
if "%WORK%"=="" for %%I in ("%~dp0..\build") do set "WORK=%%~fI"
set "CONFIG=%~3"
if "%CONFIG%"=="" set "CONFIG=Release"
rem emsdk_env sets EMSDK (forward slashes) and puts the compiler drivers on PATH.
call "%EMSDK_DIR%\emsdk_env.bat" >nul 2>&1
cmake -S "%~dp0." -B "%WORK%\core-%CONFIG%" -G Ninja -DCMAKE_BUILD_TYPE=%CONFIG% ^
  -DCMAKE_TOOLCHAIN_FILE=%EMSDK%/upstream/emscripten/cmake/Modules/Platform/Emscripten.cmake ^
  -DSDK_PREFIX=%WORK:\=/%/sdk || exit /b 1
cmake --build "%WORK%\core-%CONFIG%" || exit /b 1
