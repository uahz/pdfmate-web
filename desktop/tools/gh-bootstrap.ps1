# GitHub repo bootstrap for PDFMate (token via GH_TOKEN env, ASCII only)
$ErrorActionPreference = 'Continue'
if (-not $env:GH_TOKEN) { Write-Output 'NO_TOKEN'; exit 1 }
Write-Output ('LOGIN=' + ((gh api user --jq '.login') | Out-String).Trim())
$exists = gh api repos/uahz/pdfmate-web --jq '.full_name' 2>&1 | Out-String
if ($exists.Trim() -eq 'uahz/pdfmate-web') {
  Write-Output 'REPO_ALREADY_EXISTS'
} else {
  $body = '{"name":"pdfmate-web","description":"PDFMate - client-side PDF tools (Web + Android + iOS), no uploads","private":false,"auto_init":false,"has_issues":true}'
  $tmp = Join-Path $env:TEMP 'pm-create-repo.json'
  Set-Content -Path $tmp -Value $body -Encoding ASCII
  $out = gh api -X POST '/user/repos' --input $tmp 2>&1 | Out-String
  Write-Output ('CREATE: ' + $out.Substring(0, [Math]::Min(200, $out.Length)).Trim())
}
