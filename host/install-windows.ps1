param(
  [Parameter(Mandatory = $true)]
  [string]$ExtensionId
)
 $ErrorActionPreference = "Stop"
if ($ExtensionId -notmatch '^[a-p]{32}$') {
  throw "Некорректный ID расширения: ожидаются 32 символа a-p (см. chrome://extensions)"
}
 $HostName   = "com.camera.audio"
 $InstallDir = Join-Path $env:LOCALAPPDATA "CameraAudioHost"

New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
Copy-Item (Join-Path $PSScriptRoot "camera_audio_host.py") $InstallDir -Force
Copy-Item (Join-Path $PSScriptRoot "run_host.bat") $InstallDir -Force

 $manifest = [ordered]@{
  name            = $HostName
  description     = "Native messaging host: audio stream of IP camera"
  path            = (Join-Path $InstallDir "run_host.bat")
  type            = "stdio"
  allowed_origins = @("chrome-extension://$ExtensionId/")
}
 $manifestPath = Join-Path $InstallDir "$HostName.json"
 $manifest | ConvertTo-Json | Set-Content -Path $manifestPath -Encoding UTF8

# Регистрация через reg.exe: создаёт ВСЮ цепочку ключей и default-значение одним вызовом.
# (New-Item -Force в Windows PowerShell 5.1 падает, когда промежуточные ключи
#  ещё не существуют: "Невозможно удалить дерево подраздела".)
 $roots = @(
  "HKCU\Software\Google\Chrome\NativeMessagingHosts",
  "HKCU\Software\Chromium\NativeMessagingHosts",
  "HKCU\Software\Microsoft\Edge\NativeMessagingHosts"
)
foreach ($root in $roots) {
  $keyPath = "$root\$HostName"
  & reg.exe add "$keyPath" /ve /t REG_SZ /d "$manifestPath" /f | Out-Null
  if ($LASTEXITCODE -ne 0) {
    throw "Не удалось записать ключ реестра: HKCU\$keyPath"
  }
  Write-Host "  зарегистрировано: HKCU\$keyPath"
}
Write-Host "Готово. Native host установлен в $InstallDir"
Write-Host "Манифест: $manifestPath"
