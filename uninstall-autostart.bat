@echo off
setlocal
title OmniNovel - Remove Auto-Start

set "LNK=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\OmniNovel Dev Server.lnk"

if exist "%LNK%" (
    del "%LNK%"
    echo Removed the auto-start shortcut.
) else (
    echo No auto-start shortcut found - nothing to remove.
)
echo.
pause
endlocal
