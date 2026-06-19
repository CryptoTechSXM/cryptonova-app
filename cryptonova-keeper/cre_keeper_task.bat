@echo off
cd /d C:\CryptoNite-Smart-Contracts\CryptoNova\cryptonova-keeper
echo [%date% %time%] Running CRE simulate (staging) >> cre_keeper.log
cre workflow simulate my-workflow --target staging-settings --broadcast --trigger-index 0 --non-interactive >> cre_keeper.log 2>&1
echo. >> cre_keeper.log
