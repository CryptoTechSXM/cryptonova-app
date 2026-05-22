@echo off
REM Self-delete so git_sync.py does not see this wrapper file.
del /Q "%~f0"
set "OUTDIR=C:\Users\CryptoTech\AppData\Roaming\Claude\local-agent-mode-sessions\02a2ee21-7e53-479c-a560-5a2b6d32d86b\1eebb3d8-73c4-4513-b157-fc575c9a64e8\local_3d8218a2-15a4-4c2c-9460-af21e4a5552c\outputs"
echo === CryptoNite Git Sync Run ===                            >  "%OUTDIR%\sync_output.log"
echo Started: %DATE% %TIME%                                     >> "%OUTDIR%\sync_output.log"
echo.                                                           >> "%OUTDIR%\sync_output.log"
python "C:\CryptoNite-MT5-Bots\git_sync.py"                     >> "%OUTDIR%\sync_output.log" 2>&1
set "RC=%ERRORLEVEL%"
echo.                                                           >> "%OUTDIR%\sync_output.log"
echo === Exit code: %RC% ===                                    >> "%OUTDIR%\sync_output.log"
echo Completed: %DATE% %TIME%                                   >> "%OUTDIR%\sync_output.log"
echo done > "%OUTDIR%\sync_done.flag"
