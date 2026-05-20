@echo off
cd /d C:\CryptoNite-MT5-Bots
python git_sync.py > "C:\CryptoNite-MT5-Bots\1-btc-ha-bot\git_sync_output.txt" 2>&1
echo EXIT_CODE=%ERRORLEVEL% >> "C:\CryptoNite-MT5-Bots\1-btc-ha-bot\git_sync_output.txt"
