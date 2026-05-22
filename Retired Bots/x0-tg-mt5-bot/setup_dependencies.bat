@echo off
echo ================================================
echo  CryptoNite Bot - Dependency Setup
echo ================================================
echo.

:: Check Python is installed
python --version >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Python not found!
    echo Please install Python 3.10 or 3.11 from https://python.org
    echo Make sure to tick "Add Python to PATH" during install.
    pause
    exit /b 1
)

echo [OK] Python found:
python --version
echo.

:: Upgrade pip first
echo [1/3] Upgrading pip...
python -m pip install --upgrade pip --quiet
echo Done.
echo.

:: Install all bot dependencies
echo [2/3] Installing bot dependencies...
pip install MetaTrader5 pandas numpy python-dotenv telethon --quiet
if errorlevel 1 (
    echo [ERROR] Installation failed. Check your internet connection.
    pause
    exit /b 1
)
echo Done.
echo.

:: Verify key packages
echo [3/3] Verifying installation...
python -c "import MetaTrader5; print('  MetaTrader5 : OK')"
python -c "import pandas; print('  pandas      : OK')"
python -c "import numpy; print('  numpy       : OK')"
python -c "import dotenv; print('  python-dotenv: OK')"
python -c "import telethon; print('  telethon    : OK')"
echo.

echo ================================================
echo  All dependencies installed successfully!
echo.
echo  Next steps:
echo  1. Make sure MetaTrader 5 is open and logged in
echo  2. Copy your CryptoNite-MT5-Bots folder to this machine
echo  3. Open a terminal in any bot folder and run: python main.py
echo ================================================
echo.
pause
