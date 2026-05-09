@echo off
setlocal

set "APP_DIR=%~dp0"
set "LOG_DIR=%LOCALAPPDATA%\DemucsSeperater\logs"
set "LOG_FILE=%LOG_DIR%\launcher.log"

if not exist "%LOG_DIR%" mkdir "%LOG_DIR%" >nul 2>nul

>> "%LOG_FILE%" echo.
>> "%LOG_FILE%" echo ===== %DATE% %TIME% =====
>> "%LOG_FILE%" echo APP_DIR=%APP_DIR%
>> "%LOG_FILE%" echo EXE=%APP_DIR%DemucsSeperater.exe
>> "%LOG_FILE%" echo LOCALAPPDATA=%LOCALAPPDATA%

set "PATH=%APP_DIR%bin;%PATH%"
>> "%LOG_FILE%" echo BUNDLED_FFMPEG=%APP_DIR%bin\ffmpeg.exe

"%APP_DIR%DemucsSeperater.exe" >> "%LOG_FILE%" 2>&1
set "EXIT_CODE=%ERRORLEVEL%"

>> "%LOG_FILE%" echo EXIT_CODE=%EXIT_CODE%

if not "%EXIT_CODE%"=="0" (
  echo DemucsSeperater exited with code %EXIT_CODE%.
  echo.
  echo Log file:
  echo %LOG_FILE%
  echo.
  pause
)

exit /b %EXIT_CODE%
