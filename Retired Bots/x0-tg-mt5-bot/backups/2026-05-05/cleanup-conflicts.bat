@echo off
echo Cleaning up Syncthing conflict files from C:\CryptoNite-MT5-Bots\...
echo.

del /s /q "C:\CryptoNite-MT5-Bots\*.sync-conflict-*" 2>nul
for /r "C:\CryptoNite-MT5-Bots" %%f in (*.sync-conflict-*) do (
    echo Deleting: %%f
    del /q "%%f"
)

echo.
echo Done. All conflict files removed.
pause
