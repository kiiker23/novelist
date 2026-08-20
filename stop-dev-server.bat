@echo off
setlocal
title OmniNovel - Stop Dev Server
echo Stopping the OmniNovel dev server (ports 5173-5175)...
echo.
powershell -NoProfile -ExecutionPolicy Bypass -Command "$p=5173,5174,5175;$f=$false;Get-NetTCPConnection -State Listen -LocalPort $p -ErrorAction SilentlyContinue|ForEach-Object{$q=$_.OwningProcess;$pr=Get-CimInstance Win32_Process|Where-Object{$_.ProcessId -eq $q};if($pr -and $pr.CommandLine -match 'vite' -and $pr.CommandLine -match 'Gnovel'){$f=$true;$c=$pr;while($true){$pa=Get-CimInstance Win32_Process|Where-Object{$_.ProcessId -eq $c.ParentProcessId};if(-not $pa -or $pa.ProcessId -eq $c.ProcessId){break};if($pa.Name -match '^(cmd|node)\.exe$' -and $pa.CommandLine -match 'npm|vite'){$c=$pa}else{break}};Write-Host ('Stopping tree root PID {0} ({1})' -f $c.ProcessId,$c.Name);& taskkill /PID $c.ProcessId /T /F 2>$null|Out-Null;Start-Sleep -Milliseconds 300}};if(-not $f){Write-Host 'No OmniNovel (Gnovel) dev server found on ports 5173-5175.'};Start-Sleep -Milliseconds 500;$l=Get-NetTCPConnection -State Listen -LocalPort $p -ErrorAction SilentlyContinue;if($l){Write-Host 'WARNING: these ports are still busy:';$l|ForEach-Object{Write-Host ('  {0} -> PID {1}' -f $_.LocalPort,$_.OwningProcess)}}else{Write-Host 'Done. Ports 5173-5175 are free.'}"
echo.
pause
endlocal
