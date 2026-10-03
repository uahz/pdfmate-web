# PDFMate icon generator (System.Drawing, ASCII only)
param(
  [Parameter(Mandatory=$true)][string]$WebDir,
  [Parameter(Mandatory=$true)][string]$BuildIconPath
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

function RoundPath([float]$x, [float]$y, [float]$w, [float]$h, [float]$r) {
  $p = New-Object System.Drawing.Drawing2D.GraphicsPath
  $d = $r * 2
  $p.AddArc($x, $y, $d, $d, 180, 90)
  $p.AddArc($x + $w - $d, $y, $d, $d, 270, 90)
  $p.AddArc($x + $w - $d, $y + $h - $d, $d, $d, 0, 90)
  $p.AddArc($x, $y + $h - $d, $d, $d, 90, 90)
  $p.CloseFigure()
  return $p
}

function Make-Icon([int]$size, [string]$path, [bool]$maskable) {
  $bmp = New-Object System.Drawing.Bitmap($size, $size)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAlias
  $g.Clear([System.Drawing.Color]::Transparent)

  $rect = New-Object System.Drawing.Rectangle(0, 0, $size, $size)
  $c1 = [System.Drawing.Color]::FromArgb(255, 79, 124, 255)
  $c2 = [System.Drawing.Color]::FromArgb(255, 108, 92, 255)
  $brush = New-Object System.Drawing.Drawing2D.LinearGradientBrush($rect, $c1, $c2, 45)

  if ($maskable) {
    # maskable: full-bleed square, glyph in safe zone
    $g.FillRectangle($brush, $rect)
  } else {
    $r = $size * 0.28
    $rp = RoundPath 0 0 $size $size $r
    $g.FillPath($brush, $rp)
    $rp.Dispose()
  }

  $fontSize = $size * 0.52
  $font = New-Object System.Drawing.Font('Segoe UI', [float]$fontSize, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
  $sf = New-Object System.Drawing.StringFormat
  $sf.Alignment = [System.Drawing.StringAlignment]::Center
  $sf.LineAlignment = [System.Drawing.StringAlignment]::Center
  $glyphRect = New-Object System.Drawing.RectangleF(0, 0, $size, $size)
  $g.DrawString('P', $font, [System.Drawing.Brushes]::White, $glyphRect, $sf)

  $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose()
  $font.Dispose()
  $brush.Dispose()
  $bmp.Dispose()
  Write-Output ('ICON ' + $path)
}

Make-Icon 192 (Join-Path $WebDir 'icon-192.png') $false
Make-Icon 512 (Join-Path $WebDir 'icon-512.png') $false
Make-Icon 512 (Join-Path $WebDir 'icon-512-maskable.png') $true
$buildDir = Split-Path -Parent $BuildIconPath
New-Item -ItemType Directory -Force $buildDir | Out-Null
Make-Icon 512 $BuildIconPath $false
Write-Output 'DONE'
