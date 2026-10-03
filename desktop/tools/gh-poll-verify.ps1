# Poll latest push-triggered builds; verify brand icon inside new APK (ASCII only)
$ErrorActionPreference = 'Continue'
$repo = 'uahz/pdfmate-web'

function Get-LatestRunId($wf) {
  $r = gh api "repos/$repo/actions/workflows/$wf/runs?per_page=1" --jq '.workflow_runs[0].id' 2>$null | Out-String
  return $r.Trim()
}
function Get-RunState($id) {
  return (gh api "repos/$repo/actions/runs/$id" --jq '.conclusion // .status' 2>$null | Out-String).Trim()
}

$aId = Get-LatestRunId 'android-apk.yml'
$iId = Get-LatestRunId 'ios-ipa.yml'
Write-Output ("RUN android=$aId ios=$iId")

for ($i = 0; $i -lt 40; $i++) {
  $a = Get-RunState $aId
  $b = Get-RunState $iId
  Write-Output ("T+{0,3}s  android={1}  ios={2}" -f ($i * 12), $a, $b)
  if ($a -ne 'in_progress' -and $a -ne 'queued' -and $b -ne 'in_progress' -and $b -ne 'queued') { break }
  Start-Sleep -Seconds 12
}

Write-Output '--- verify brand icon inside fresh APK ---'
$apk = Join-Path $env:TEMP 'PDFMate-1.0.0-android.apk'
if (Test-Path $apk) { Remove-Item $apk -Force }
Invoke-WebRequest -Uri "https://github.com/$repo/releases/download/v1.0.0/PDFMate-1.0.0-android.apk" -OutFile $apk -UseBasicParsing
Add-Type -AssemblyName System.IO.Compression.FileSystem
Add-Type -AssemblyName System.Drawing
$zip = [IO.Compression.ZipFile]::OpenRead($apk)
$entry = $zip.Entries | Where-Object { $_.FullName -eq 'res/mipmap-xxxhdpi/ic_launcher.png' } | Select-Object -First 1
if ($entry) {
  $tmpPng = Join-Path $env:TEMP 'apk-icon.png'
  [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $tmpPng, $true)
  $bmp = New-Object System.Drawing.Bitmap($tmpPng)
  $c1 = $bmp.GetPixel(4, 4)
  $c2 = $bmp.GetPixel([int]($bmp.Width / 2), [int]($bmp.Height / 2))
  Write-Output ('ICON_SIZE=' + $bmp.Width + 'x' + $bmp.Height)
  Write-Output ('CORNER_RGB=' + $c1.R + ',' + $c1.G + ',' + $c1.B)
  Write-Output ('CENTER_RGB=' + $c2.R + ',' + $c2.G + ',' + $c2.B)
  $brand = ([Math]::Abs($c1.R - 79) -lt 30) -and ([Math]::Abs($c1.G - 124) -lt 30) -and ([Math]::Abs($c1.B - 255) -lt 30)
  Write-Output ('BRAND_ICON=' + $brand)
  $bmp.Dispose()
} else {
  Write-Output 'LEGACY_PNG_NOT_FOUND (checking adaptive xml)'
  $adaptive = $zip.Entries | Where-Object { $_.FullName -match 'mipmap-anydpi-v26/ic_launcher' } | Select-Object -First 1 -ExpandProperty FullName
  Write-Output ('ADAPTIVE=' + $adaptive)
}
$zip.Dispose()
Write-Output DONE
