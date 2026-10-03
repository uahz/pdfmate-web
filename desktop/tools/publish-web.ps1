# Publish PDFMate Web to GitHub Pages via Contents API (ASCII only)
$ErrorActionPreference = 'Continue'
$owner = 'uahz'
$repo = 'pdfmate-web'
$webdir = Join-Path (Split-Path -Parent $PSScriptRoot) 'webapp'

Write-Output '--- ensure repo exists ---'
$check = (gh api "repos/$owner/$repo" --jq '.full_name' 2>&1 | Out-String).Trim()
if ($check -ne "$owner/$repo") {
  gh repo create "$owner/$repo" --public --description 'PDFMate Web - client-side PDF/image tools, no uploads' 2>&1 | Out-String | Write-Output
} else {
  Write-Output "REPO_OK $check"
}

$files = @(
  'index.html',
  'app.js',
  'theme.css',
  'sw.js',
  'manifest.webmanifest',
  'package.json',
  'capacitor.config.json',
  '.gitignore',
  'README.md',
  '.github/workflows/android-apk.yml',
  '.github/workflows/ios-ipa.yml',
  '.github/workflows/ios-signed.yml',
  'assets/icon-only.png',
  'assets/icon-foreground.png',
  'assets/icon-background.png',
  'assets/splash.png',
  'assets/splash-dark.png',
  'icons/favicon.svg',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-512-maskable.png'
)

function PutFile($rel) {
  $p = Join-Path $webdir ($rel -replace '/', '\')
  $b64 = [Convert]::ToBase64String([IO.File]::ReadAllBytes($p))
  $raw = (gh api "repos/$owner/$repo/contents/$rel" --jq '.sha' 2>$null | Out-String).Trim()
  $sha = ''
  if ($raw -match '^[0-9a-f]{40}$') { $sha = $Matches[0] }
  $bodyFile = Join-Path $env:TEMP 'pm-put-body.json'
  if ($sha) {
    Set-Content -Path $bodyFile -Value ('{"message":"feat: update ' + $rel + '","content":"' + $b64 + '","sha":"' + $sha + '"}') -Encoding ASCII
  } else {
    Set-Content -Path $bodyFile -Value ('{"message":"feat: add ' + $rel + '","content":"' + $b64 + '"}') -Encoding ASCII
  }
  gh api -X PUT "repos/$owner/$repo/contents/$rel" --input $bodyFile | Out-Null
  if ($LASTEXITCODE -eq 0) { Write-Output ('OK ' + $rel) } else { Write-Output ('FAILED   ' + $rel) }
}

foreach ($rel in $files) {
  PutFile $rel
}

Write-Output '--- enable GitHub Pages (branch: main / root) ---'
$pagesJson = Join-Path $env:TEMP 'pdfmate-pages.json'
Set-Content -Path $pagesJson -Value '{"source":{"branch":"main","path":"/"},"build_type":"legacy"}' -Encoding ASCII
gh api -X POST "repos/$owner/$repo/pages" --input $pagesJson 2>&1 | Out-String | Write-Output

Write-Output '--- repo url ---'
Write-Output "https://github.com/$owner/$repo"
Write-Output "https://$owner.github.io/$repo/ (Pages builds in 1-3 min)"
