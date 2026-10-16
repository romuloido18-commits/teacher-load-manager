$ErrorActionPreference = 'Stop'

$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$outputDirectory = Join-Path $projectRoot 'dist'
$compiler = Join-Path $env:LOCALAPPDATA 'Programs\Inno Setup 6\ISCC.exe'
$csharpCompiler = 'C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe'

if (-not (Test-Path $compiler)) {
    throw "Inno Setup 6 compiler was not found at $compiler."
}
if (-not (Test-Path $csharpCompiler)) {
    throw ".NET Framework C# compiler was not found at $csharpCompiler."
}

New-Item -ItemType Directory -Path $outputDirectory -Force | Out-Null
$launcher = Join-Path $outputDirectory 'TeacherLoadManager.exe'

& $csharpCompiler /nologo /target:winexe /platform:anycpu /optimize+ `
    /out:$launcher /reference:System.Windows.Forms.dll `
    (Join-Path $PSScriptRoot 'TeacherLoadManager.cs')
if ($LASTEXITCODE -ne 0) {
    throw "The Windows launcher failed to compile (exit code $LASTEXITCODE)."
}

& $compiler "/DProjectRoot=$projectRoot" (Join-Path $PSScriptRoot 'TeacherLoadManager.iss')
if ($LASTEXITCODE -ne 0) {
    throw "The Windows installer failed to compile (exit code $LASTEXITCODE)."
}

Get-Item $launcher, (Join-Path $outputDirectory 'Teacher Load Manager Setup.exe') |
    Select-Object FullName, Length
