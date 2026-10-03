# Create release v1.0.0 with PC installers, then trigger mobile build workflows (ASCII only)
$ErrorActionPreference = 'Continue'
$repo = 'uahz/pdfmate-web'
$relDir = Join-Path (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)) 'release'

Write-Output '--- release ---'
$exists = (gh release view v1.0.0 -R $repo --json tagName 2>&1 | Out-String).Trim()
if ($exists -match 'v1\.0\.0') {
  Write-Output 'RELEASE_EXISTS'
} else {
  gh release create v1.0.0 -R $repo -t 'PDFMate v1.0.0' -n 'PDFMate installers: Windows (Setup / Portable), Android (APK), iOS (unsigned IPA). All processing is done locally on your device.' | Out-String | Write-Output
}

Write-Output '--- upload PC installers ---'
gh release upload v1.0.0 (Join-Path $relDir 'PDFMate Setup 1.0.0.exe') (Join-Path $relDir 'PDFMate 1.0.0.exe') --clobber -R $repo 2>&1 | Out-String | Write-Output
Write-Output ('UPLOAD_EXIT=' + $LASTEXITCODE)

Write-Output '--- trigger workflows ---'
gh workflow run android-apk.yml -R $repo --ref main
Write-Output ('TRIGGER_ANDROID=' + $LASTEXITCODE)
gh workflow run ios-ipa.yml -R $repo --ref main
Write-Output ('TRIGGER_IOS=' + $LASTEXITCODE)
