Set-Location "C:\CryptoNite-Smart-Contracts\CryptoNova"
$ts = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
"[$ts] Rescue keeper starting..." | Add-Content "logs\rescue.log"
& node_modules\.bin\hardhat.cmd run scripts/manual_rescue.js --network baseSepolia 2>&1 | Add-Content "logs\rescue.log"
