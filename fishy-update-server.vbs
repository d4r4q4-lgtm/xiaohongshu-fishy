' Keep the local update server alive for Tampermonkey
' Re-checks every 2 minutes and restarts node if the port stops answering.
Option Explicit
Dim fso, sh, base, sub, nodeExe, scriptPath, best, http, ok

Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")

scriptPath = "D:\OneDrive\.workbuddy\2026-10-26-15-06-03\fishy\serve.mjs"
If Not fso.FileExists(scriptPath) Then WScript.Quit 0

nodeExe = ""
base = sh.ExpandEnvironmentStrings("%USERPROFILE%") & "\.workbuddy\binaries\node\versions"
If fso.FolderExists(base) Then
  best = ""
  For Each sub In fso.GetFolder(base).SubFolders
    If fso.FileExists(sub.Path & "\node.exe") Then
      If sub.Name > best Then best = sub.Name
    End If
  Next
  If best <> "" Then nodeExe = base & "\" & best & "\node.exe"
End If
If Not fso.FileExists(nodeExe) Then nodeExe = sh.ExpandEnvironmentStrings("%ProgramFiles%") & "\nodejs\node.exe"
If Not fso.FileExists(nodeExe) Then nodeExe = sh.ExpandEnvironmentStrings("%ProgramFiles(x86)%") & "\nodejs\node.exe"
If Not fso.FileExists(nodeExe) Then WScript.Quit 0

sh.CurrentDirectory = fso.GetParentFolderName(scriptPath)

Do
  ok = False
  On Error Resume Next
  Set http = CreateObject("MSXML2.XMLHTTP.6.0")
  http.Open "GET", "http://127.0.0.1:8125/version", False
  http.Send
  If Err.Number = 0 Then
    If http.Status = 200 Then ok = True
  End If
  Err.Clear
  On Error GoTo 0

  If Not ok Then
    sh.Run """" & nodeExe & """ """ & scriptPath & """", 0, False
  End If

  WScript.Sleep 120000
Loop
