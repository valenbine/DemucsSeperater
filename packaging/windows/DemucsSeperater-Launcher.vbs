Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

appDir = fso.GetParentFolderName(WScript.ScriptFullName)
command = "cmd.exe /c """ & appDir & "\DemucsSeperater-Launcher.cmd""" 

shell.Run command, 0, False
