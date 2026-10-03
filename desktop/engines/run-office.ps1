# PDFMate Office COM conversion bridge (ASCII only)
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File run-office.ps1 -ListFile <utf16le list> -OutDir <dir>
# Prints per-file result lines:  OK|<name>  or  ERR|<name>|<ascii message>
param(
  [Parameter(Mandatory=$true)][string]$ListFile,
  [Parameter(Mandatory=$true)][string]$OutDir
)
$ErrorActionPreference = 'Continue'
$apps = @{}

function Get-WordApp {
  if (-not $apps.ContainsKey('word')) {
    $w = New-Object -ComObject Word.Application
    $w.Visible = $false
    $w.DisplayAlerts = 0
    $apps['word'] = $w
  }
  return $apps['word']
}
function Get-ExcelApp {
  if (-not $apps.ContainsKey('excel')) {
    $e = New-Object -ComObject Excel.Application
    $e.Visible = $false
    $e.DisplayAlerts = $false
    $apps['excel'] = $e
  }
  return $apps['excel']
}
function Get-PptApp {
  if (-not $apps.ContainsKey('ppt')) {
    $p = New-Object -ComObject PowerPoint.Application
    $apps['ppt'] = $p
  }
  return $apps['ppt']
}

$lines = [System.IO.File]::ReadAllLines($ListFile)
foreach ($p in $lines) {
  if ([string]::IsNullOrWhiteSpace($p)) { continue }
  $p = $p.Trim()
  if (-not (Test-Path -LiteralPath $p)) {
    Write-Output ('ERR|' + [System.IO.Path]::GetFileName($p) + '|FILE_NOT_FOUND')
    continue
  }
  $name = [System.IO.Path]::GetFileNameWithoutExtension($p)
  $ext = [System.IO.Path]::GetExtension($p).ToLower()
  $out = Join-Path $OutDir ($name + '.pdf')
  try {
    switch -Regex ($ext) {
      '^\.(docx|doc|rtf|txt)$' {
        $w = Get-WordApp
        $doc = $w.Documents.Open($p, $false, $true)
        $doc.ExportAsFixedFormat($out, 17)
        $doc.Close(0)
      }
      '^\.(xlsx|xls|csv)$' {
        $e = Get-ExcelApp
        $wb = $e.Workbooks.Open($p, 0, $true)
        $wb.ExportAsFixedFormat(0, $out)
        $wb.Close($false)
      }
      '^\.(pptx|ppt|pps|ppsx)$' {
        $pp = Get-PptApp
        $pres = $pp.Presentations.Open($p, $true, 0, 0)
        $pres.SaveAs($out, 32)
        $pres.Close()
      }
      default {
        Write-Output ('ERR|' + $name + '|UNSUPPORTED_TYPE')
        continue
      }
    }
    Start-Sleep -Milliseconds 150
    if (-not (Test-Path -LiteralPath $out)) { throw 'NO_OUTPUT' }
    Write-Output ('OK|' + $name)
  } catch {
    $msg = $_.Exception.Message
    $b64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($msg))
    $hr = ('0x{0:X8}' -f $_.Exception.HResult)
    Write-Output ('ERR|' + $name + '|' + $hr + '|' + $b64)
    try {
      if ($doc) { $doc.Close(0) }
    } catch {}
  }
}
foreach ($k in $apps.Keys) {
  try { $apps[$k].Quit() } catch {}
}
Write-Output 'DONE'
