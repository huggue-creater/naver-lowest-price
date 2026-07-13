' 4060 insight dashboard server - silent background launcher
' Runs node server.js with no console window. Used by the Startup folder shortcut.
Set sh  = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
Set env = sh.Environment("PROCESS")
env("NO_OPEN") = "1"
If fso.FileExists(dir & "\corp-root-ca.pem") Then
  env("NODE_EXTRA_CA_CERTS") = dir & "\corp-root-ca.pem"
ElseIf fso.FileExists(fso.GetParentFolderName(dir) & "\corp-root-ca.pem") Then
  env("NODE_EXTRA_CA_CERTS") = fso.GetParentFolderName(dir) & "\corp-root-ca.pem"
End If
sh.Run "node """ & dir & "\server.js""", 0, False
