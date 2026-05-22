@echo off
cd /d C:\CryptoNite-MT5-Bots
python C:\CryptoNite-MT5-Bots\git_sync.py > "C:\CryptoNite-MT5-Bots\1-btc-ha-bot\_sync_output.txt" 2>&1
echo --- EXIT CODE: %ERRORLEVEL% --- >> "C:\CryptoNite-MT5-Bots\1-btc-ha-bot\_sync_output.txt"
echo DONE > "C:\CryptoNite-MT5-Bots\1-btc-ha-bot\_sync_done.txt"
