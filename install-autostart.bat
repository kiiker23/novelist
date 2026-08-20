@echo off
setlocal
title OmniNovel - Install Auto-Start
cd /d "%~dp0"

set "STARTUP=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup"
set "LNK=%STARTUP%\OmniNovel Dev Server.lnk"

if not exist "%STARTUP%" (
    echo ERROR: Windows Startup folder not found:
    echo   %STARTUP%
    pause
    exit /b 1
)

powershell -NoProfile -Command "$s=(New-Object -ComObject WScript.Shell).CreateShortcut('%LNK%'); $s.TargetPath='%~dp0start-dev-server.bat'; $s.WorkingDirectory='%~dp0'; $s.WindowStyle=7; $s.Description='Starts the OmniNovel dev server at Windows login'; $s.Save()"
if errorlevel 1 (
    echo.
    echo FAILED to create the shortcut. See the error above.
    pause
    exit /b 1
)

echo.
echo Installed. The OmniNovel dev server will start automatically
echo the next time you log in to Windows.
echo.
echo   Shortcut : %LNK%
echo   Target   : %~dp0start-dev-server.bat
echo.
echo The server window opens minimized. To use the app, open
echo http://localhost:5173/ in your browser (Vite moves to
echo 5174/5175 if that port is already busy - restore the server
echo window from the taskbar to see which URL it printed).
echo.
echo To undo: double-click uninstall-autostart.bat
echo.
pause
endlocal
