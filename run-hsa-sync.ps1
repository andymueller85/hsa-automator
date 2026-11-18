$WorkDir = $PSScriptRoot
Set-Location $WorkDir
cmd.exe /c "npm run sync >> `"$WorkDir\sync.log`" 2>&1"
