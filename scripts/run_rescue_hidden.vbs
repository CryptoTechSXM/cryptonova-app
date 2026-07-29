' run_rescue_hidden.vbs
' Runs manual_rescue.js via node WITHOUT showing a terminal popup window.
' Used by Windows Task Scheduler so the rescue task is fully silent.
'
' To update the Task Scheduler task:
'   Program/script : wscript.exe
'   Add arguments  : "C:\CryptoNite-Smart-Contracts\CryptoNova\scripts\run_rescue_hidden.vbs"
'   Start in       : C:\CryptoNite-Smart-Contracts\CryptoNova

Dim WshShell
Set WshShell = CreateObject("WScript.Shell")

' 0 = hidden window, False = fire-and-forget (don't block)
WshShell.Run "cmd /c cd /d C:\CryptoNite-Smart-Contracts\CryptoNova && npx hardhat run scripts\manual_rescue.js --network baseSepolia >> logs\rescue_task.log 2>&1", 0, False

Set WshShell = Nothing
