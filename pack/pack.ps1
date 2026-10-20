$ErrorActionPreference = "Stop"
 $here = $PSScriptRoot
 $src  = Join-Path $here "..\extension"
 $out  = Join-Path $here "camera-audio-extension.zip"
if (Test-Path $out) { Remove-Item $out -Force }
Compress-Archive -Path (Join-Path $src "*") -DestinationPath $out
Write-Host "OK: $out"
Write-Host "Примечание: для стабильного ID расширения используйте key.pem (см. pack.sh / README)."
