#define MyAppName "DemucsSeperater"
#define MyAppVersion "1.0.0"
#define MyAppPublisher "猫仙森MRCAT"
#define MyAppURL "https://github.com/valenbine/DemucsSeperater"
#define MyAppExeName "DemucsSeperater.exe"

[Setup]
AppId={{5D1E8C76-78D4-4C73-BBB7-3314682E89BA}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
AppPublisherURL={#MyAppURL}
AppSupportURL={#MyAppURL}
AppUpdatesURL={#MyAppURL}
DefaultDirName={autopf}\{#MyAppName}
DisableProgramGroupPage=yes
LicenseFile=
OutputDir=..\dist
OutputBaseFilename=DemucsSeperater-Setup-x64
SetupIconFile=..\dist\DemucsSeperater.ico
Compression=lzma
SolidCompression=yes
WizardStyle=modern
ArchitecturesInstallIn64BitMode=x64compatible

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "Create a desktop shortcut"; GroupDescription: "Additional icons:"; Flags: unchecked

[Files]
Source: "..\dist\DemucsSeperater.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\dist\DemucsSeperater-Tray.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\dist\DemucsSeperater.ico"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\dist\DemucsSeperater.svg"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\dist\DemucsSeperater-Launcher.cmd"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\dist\DemucsSeperater-Launcher.vbs"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\dist\assets\*"; DestDir: "{app}\assets"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "..\dist\bin\*"; DestDir: "{app}\bin"; Flags: ignoreversion recursesubdirs createallsubdirs

[Dirs]
Name: "{localappdata}\DemucsSeperater\logs"

[Icons]
Name: "{autoprograms}\{#MyAppName}"; Filename: "{app}\DemucsSeperater-Tray.exe"; WorkingDir: "{app}"; IconFilename: "{app}\DemucsSeperater.ico"
Name: "{autoprograms}\{#MyAppName} Debug Console"; Filename: "{cmd}"; Parameters: "/K ""{app}\DemucsSeperater-Launcher.cmd"""; WorkingDir: "{app}"; IconFilename: "{app}\DemucsSeperater.ico"
Name: "{autoprograms}\Open {#MyAppName} Logs"; Filename: "{win}\explorer.exe"; Parameters: """{localappdata}\DemucsSeperater\logs"""; IconFilename: "{app}\DemucsSeperater.ico"
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\DemucsSeperater-Tray.exe"; WorkingDir: "{app}"; IconFilename: "{app}\DemucsSeperater.ico"; Tasks: desktopicon

[Run]
Filename: "{app}\DemucsSeperater-Tray.exe"; Description: "Launch {#MyAppName}"; Flags: nowait postinstall skipifsilent
