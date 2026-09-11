' Runs one check without flashing a console window. Used by the scheduled task.
Set fso = CreateObject("Scripting.FileSystemObject")
root = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))
If Not fso.FolderExists(root & "\logs") Then fso.CreateFolder(root & "\logs")
Set shell = CreateObject("WScript.Shell")
shell.CurrentDirectory = root
shell.Run "cmd /c node --disable-warning=ExperimentalWarning src\index.js >> logs\observer.log 2>&1", 0, True
