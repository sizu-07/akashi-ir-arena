$ErrorActionPreference='Stop'
$errorsFound=@()
Get-ChildItem -LiteralPath $PSScriptRoot -Filter '*.ps1' | ForEach-Object {
  $parseErrors=$null; $tokens=$null
  $null=[System.Management.Automation.Language.Parser]::ParseFile($_.FullName,[ref]$tokens,[ref]$parseErrors)
  foreach($entry in $parseErrors) { $errorsFound+=$_.Name+': '+$entry.Message }
}
if($errorsFound.Count) { $errorsFound|Write-Output; exit 1 }
Write-Output ('PowerShell '+$PSVersionTable.PSVersion+': all scripts parsed successfully')
