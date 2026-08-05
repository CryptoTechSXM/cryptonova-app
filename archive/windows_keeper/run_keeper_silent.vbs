Dim oShell
Set oShell = CreateObject("WScript.Shell")
' 0 = hidden window, False = fire-and-forget
oShell.Run "cmd /c """ & "C:\CryptoNite-Smart-Contracts\CryptoNova\run_keeper.bat" & """", 0, False
Set oShell = Nothing
