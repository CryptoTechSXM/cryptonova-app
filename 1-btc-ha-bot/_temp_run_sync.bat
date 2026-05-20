@echo off
cd /d C:\CryptoNite-MT5-Bots
python git_sync.py > "C:\CryptoNite-MT5-Bots\1-btc-ha-bot\_sync_output.txt" 2>&1
echo. >> "C:\CryptoNite-MT5-Bots\1-btc-ha-bot\_sync_output.txt"
echo ===SYNC_COMPLETE=== >> "C:\CryptoNite-MT5-Bots\1-btc-ha-bot\_sync_output.txt"
