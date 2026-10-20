$HostName = "com.camera.audio"
 $roots = @(
  "HKCU\Software\Google\Chrome\NativeMessagingHosts",
  "HKCU\Software\Chromium\NativeMessagingHosts",
  "HKCU\Software\Microsoft\Edge\NativeMessagingHosts"
)
foreach ($root in $roots) {
  # reg.exe delete молча "ошибается", если ключа нет — это норма для деинсталлятора
  & reg.exe delete "$root\$HostName" /f | Out-Null
  Write-Host "  удалено: HKCU\$root\$HostName"
}
Remove-Item (Join-Path $env:LOCALAPPDATA "CameraAudioHost") -Recurse -Force -ErrorAction SilentlyContinue
Write-Host "Готово. Native host удалён."
