@echo off
REM Wrapper to run git_sync.py and capture output AFTER the sync completes
REM so the captured files aren't included in the commit.
set OUTDIR=%~dp0
set TMPOUT=%TEMP%\cryptonite_git_sync_output.txt
del /q "%OUTDIR%git_sync_done.flag" 2>nul
del /q "%OUTDIR%git_sync_output.txt" 2>nul
del /q "%OUTDIR%git_sync_exitcode.txt" 2>nul
python C:\CryptoNite-MT5-Bots\git_sync.py > "%TMPOUT%" 2>&1
set RC=%ERRORLEVEL%
copy /Y "%TMPOUT%" "%OUTDIR%git_sync_output.txt" >nul
echo %RC% > "%OUTDIR%git_sync_exitcode.txt"
echo DONE > "%OUTDIR%git_sync_done.flag"
