@echo off
setlocal
set "LOG=C:\CryptoNite-MT5-Bots\1-btc-ha-bot\_git_sync_output.log"
> "%LOG%" echo === START %DATE% %TIME% ===
python C:\CryptoNite-MT5-Bots\git_sync.py >> "%LOG%" 2>&1
set EC=%ERRORLEVEL%
>> "%LOG%" echo.
>> "%LOG%" echo === END EXITCODE=%EC% %DATE% %TIME% ===
endlocal
exit /b %EC%
