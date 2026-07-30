Set-Location "C:\CryptoNite-Smart-Contracts\CryptoNova"
$ts = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
"[$ts] Direct keeper starting..." | Add-Content "keeper.log"
& cmd /c "npx hardhat run scripts/direct_keeper.js --network baseSepolia >> keeper.log 2>&1"
