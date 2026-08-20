@echo off
setlocal
title OmniNovel - Dev Server
cd /d "%~dp0"

if not exist node_modules (
    echo node_modules not found - installing dependencies first...
    call npm install
    if errorlevel 1 (
        echo.
        echo npm install FAILED. Check the error above, then press a key.
        pause
        exit /b 1
    )
)

rem Optional: load DEEPSEEK_API_KEY from dev-server.env (never commit that file)
if exist "%~dp0dev-server.env" (
    for /f "usebackq tokens=1,* delims==" %%a in (`findstr /v "^#" "%~dp0dev-server.env"`) do set "%%a=%%b"
)

echo.
echo ============================================================
echo   OmniNovel Dev Server starting...
echo.
echo   URL:  http://localhost:5173/
echo         If 5173 is busy, Vite picks 5174/5175...
echo         Read the URL printed below in this window.
echo.
echo   Stop: press Ctrl+C or close this window.
echo ============================================================
echo.

call npm run dev

echo.
echo The server has stopped.
pause
endlocal
