Option Explicit

Dim fso, shell, appDir, serverScript, nodeExe, probeUrl, http, httpStatus, alreadyUp
Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")

probeUrl = "http://127.0.0.1:8866/api/session"
alreadyUp = False
httpStatus = 0
On Error Resume Next
Set http = CreateObject("MSXML2.ServerXMLHTTP.6.0")
If Not http Is Nothing Then
  http.setTimeouts 800, 800, 800, 800
  http.Open "GET", probeUrl, False
  http.Send
  If Err.Number = 0 Then
    httpStatus = http.Status
    If Err.Number = 0 Then
      If httpStatus = 200 Then
        alreadyUp = True
      End If
    End If
  End If
End If
Err.Clear
On Error GoTo 0

If alreadyUp Then
  WScript.Quit 0
End If

On Error Resume Next
shell.Environment("Process").Remove "ELECTRON_RUN_AS_NODE"
On Error GoTo 0

appDir = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))
serverScript = appDir & "\server\index.mjs"
nodeExe = "C:\Program Files\nodejs\node.exe"
If Not fso.FileExists(nodeExe) Then
  nodeExe = "node.exe"
End If

shell.CurrentDirectory = appDir
shell.Run """" & nodeExe & """ """ & serverScript & """ --standby", 0, False
