$WorkDir = $PSScriptRoot
Set-Location $WorkDir
cmd.exe /c "yarn sync >> `"$WorkDir\sync.log`" 2>&1"
