#ifndef ProjectRoot
  #define ProjectRoot ".."
#endif

#define AppName "Teacher Load Manager"
#define AppVersion "1.0.0"
#define AppPublisher "Teacher Load Manager"

[Setup]
AppId={{A1C95BC7-DA5C-42A1-957A-F08849FF94F6}
AppName={#AppName}
AppVersion={#AppVersion}
AppPublisher={#AppPublisher}
VersionInfoCompany={#AppPublisher}
VersionInfoDescription=Teacher Load Manager Windows installer
VersionInfoProductName={#AppName}
VersionInfoProductVersion={#AppVersion}
VersionInfoVersion=1.0.0.0
DefaultDirName={localappdata}\Programs\Teacher Load Manager
DefaultGroupName={#AppName}
UninstallDisplayName={#AppName}
UninstallDisplayIcon={app}\TeacherLoadManager.exe
OutputDir={#ProjectRoot}\dist
OutputBaseFilename=Teacher Load Manager Setup
SetupLogging=yes
Compression=lzma2/ultra64
SolidCompression=yes
WizardStyle=modern
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Files]
Source: "{#ProjectRoot}\dist\TeacherLoadManager.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#ProjectRoot}\api.php"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#ProjectRoot}\app.js"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#ProjectRoot}\database-schema.sql"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#ProjectRoot}\db-config.example.php"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#ProjectRoot}\index.html"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#ProjectRoot}\styles.css"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#ProjectRoot}\README.md"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{autoprograms}\Teacher Load Manager"; Filename: "{app}\TeacherLoadManager.exe"; WorkingDir: "{app}"
Name: "{autodesktop}\Teacher Load Manager"; Filename: "{app}\TeacherLoadManager.exe"; WorkingDir: "{app}"; Tasks: desktopicon

[Tasks]
Name: "desktopicon"; Description: "Create a desktop shortcut"; GroupDescription: "Additional shortcuts:"; Flags: unchecked

[Run]
Filename: "{app}\TeacherLoadManager.exe"; Description: "Launch Teacher Load Manager"; WorkingDir: "{app}"; Flags: postinstall nowait skipifsilent

[Code]
var
  XamppPage: TInputDirWizardPage;

procedure InitializeWizard();
begin
  XamppPage := CreateInputDirPage(wpSelectDir,
    'Select your XAMPP installation',
    'Teacher Load Manager needs the PHP and MySQL already installed with XAMPP.',
    'Choose the folder containing the php and mysql subfolders. The usual location is C:\xampp.',
    False, '');
  XamppPage.Add('XAMPP folder:');
  XamppPage.Values[0] := 'C:\xampp';
end;

function NextButtonClick(CurPageID: Integer): Boolean;
var
  XamppRoot: string;
begin
  Result := True;
  if CurPageID = XamppPage.ID then
  begin
    XamppRoot := AddBackslash(Trim(XamppPage.Values[0]));
    if not FileExists(XamppRoot + 'php\php.exe') or
       not FileExists(XamppRoot + 'mysql\bin\mysql.exe') or
       not FileExists(XamppRoot + 'mysql\bin\mysqld.exe') or
       not FileExists(XamppRoot + 'mysql\bin\mysql_install_db.exe') or
       not FileExists(XamppRoot + 'mysql\bin\my.ini') then
    begin
      MsgBox('The selected folder does not contain XAMPP PHP and MySQL. Select the XAMPP installation folder, such as C:\xampp.', mbError, MB_OK);
      Result := False;
    end;
  end;
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep = ssPostInstall then
    SaveStringToFile(ExpandConstant('{app}\xampp-path.txt'), Trim(XamppPage.Values[0]), False);
end;
