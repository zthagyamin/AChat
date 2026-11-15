Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")
On Error Resume Next
shell.Environment("Process").Remove "ELECTRON_RUN_AS_NODE"
On Error GoTo 0
appDir = fso.GetParentFolderName(WScript.ScriptFullName)
electronExe = appDir & "\node_modules\electron\dist\electron.exe"
extraArgs = ""
If WScript.Arguments.Count > 0 Then
  For i = 0 To WScript.Arguments.Count - 1
    extraArgs = extraArgs & " " & WScript.Arguments(i)
  Next
End If
shell.CurrentDirectory = appDir
shell.Run """" & electronExe & """ """ & appDir & """" & extraArgs, 1, False
