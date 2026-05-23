@echo off
title 247B Bot — CryptoNite Moderate Scalp
cd /d "%~dp0"

:loop
echo.
echo [%date% %time%] ====================================
echo [%date% %time%] Starting 247B Bot...
echo [%date% %time%] ====================================
python main.py
set EXIT_CODE=%errorlevel%
echo.
echo [%date% %time%] Bot exited (code %EXIT_CODE%).
if %EXIT_CODE%==0 (
    echo [%date% %time%] Clean exit — not restarting.
    goto done
)
echo [%date% %time%] Restarting in 15 seconds... (Ctrl+C to cancel)
timeout /t 15 /nobreak
goto loop

:done
echo [%date% %time%] 247B Bot stopped.
pause
