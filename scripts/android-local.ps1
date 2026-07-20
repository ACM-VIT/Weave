$ErrorActionPreference = "Stop"

$adb = Join-Path $env:LOCALAPPDATA "Android\Sdk\platform-tools\adb.exe"
if (-not (Test-Path -LiteralPath $adb)) {
  throw "Android adb was not found at $adb. Install Android SDK Platform-Tools first."
}

$devices = & $adb devices
if ($LASTEXITCODE -ne 0 -or -not ($devices -match "\sdevice$")) {
  throw "No running Android emulator or connected Android device was found."
}

foreach ($port in @(3000, 5000, 8081)) {
  & $adb reverse "tcp:$port" "tcp:$port"
  if ($LASTEXITCODE -ne 0) {
    throw "Failed to forward emulator localhost:$port to the host."
  }
}

Write-Output "Android forwarding ready: OAuth 3000, backend 5000, Metro 8081"
$env:EXPO_OFFLINE = "1"
$env:EXPO_PACKAGER_PROXY_URL = "http://127.0.0.1:8081"
& npx.cmd expo start --android --lan
if ($LASTEXITCODE -ne 0) {
  throw "Expo development server exited with code $LASTEXITCODE."
}
