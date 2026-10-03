# PDFMate Office COM health probe (ASCII only)
# Prints: OK|<b64>  or  ERR|<b64>   (base64 of UTF8 message)
$ErrorActionPreference = 'Stop'
try {
  $w = New-Object -ComObject Word.Application
  $w.Visible = $false
  $w.DisplayAlerts = 0
  $doc = $w.Documents.Add()
  $doc.Close(0)
  $w.Quit()
  Write-Output ('OK|' + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes('probe passed')))
} catch {
  $b64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($_.Exception.Message))
  Write-Output ('ERR|' + $b64)
}
