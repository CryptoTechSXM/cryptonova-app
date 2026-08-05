Dim oShell
Set oShell = CreateObject("WScript.Shell")
' 0 = hidden window, False = fire-and-forget
oShell.Run "cmd /c cd /d C:\CryptoNite-Smart-Contracts\CryptoNova && npx hardhat run scripts/manual_rescue.js --network baseSepolia >> logs\rescue.log 2>&1", 0, False
Set oShell = Nothing
