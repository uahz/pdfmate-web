# Generate Capacitor app icon/splash source assets (ASCII only - no CJK comments!)
param([Parameter(Mandatory=$true)][string]$OutDir)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
New-Item -ItemType Directory -Force $OutDir | Out-Null

function New-GradientBrush([System.Drawing.RectangleF]$rect, [float]$angle) {
  $c1 = [System.Drawing.Color]::FromArgb(255, 79, 124, 255)
  $c2 = [System.Drawing.Color]::FromArgb(255, 108, 92, 255)
  return (New-Object System.Drawing.Drawing2D.LinearGradientBrush($rect, $c1, $c2, $angle))
}

function Draw-Glyph([System.Drawing.Graphics]$g, [float]$size, [float]$scale, [string]$text) {
  $font = New-Object System.Drawing.Font('Segoe UI', [float]($size * $scale), [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
  $sf = New-Object System.Drawing.StringFormat
  $sf.Alignment = [System.Drawing.StringAlignment]::Center
  $sf.LineAlignment = [System.Drawing.StringAlignment]::Center
  $rect = New-Object System.Drawing.RectangleF(0, 0, $size, $size)
  $g.DrawString($text, $font, [System.Drawing.Brushes]::White, $rect, $sf)
  $font.Dispose()
  $sf.Dispose()
}

function Save-Icon([string]$path, [int]$size, [bool]$transparentBg, [float]$glyphScale) {
  $bmp = New-Object System.Drawing.Bitmap($size, $size)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAlias
  $rect = New-Object System.Drawing.RectangleF(0, 0, $size, $size)
  if ($transparentBg) {
    $g.Clear([System.Drawing.Color]::Transparent)
  } else {
    $brush = New-GradientBrush $rect 45
    $g.FillRectangle($brush, $rect)
    $brush.Dispose()
  }
  if ($glyphScale -gt 0) { Draw-Glyph $g $size $glyphScale 'P' }
  $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose(); $bmp.Dispose()
  Write-Output ('ICON ' + $path)
}

function Save-Splash([string]$path, [int]$size, [bool]$dark) {
  $bmp = New-Object System.Drawing.Bitmap($size, $size)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAlias
  $rect = New-Object System.Drawing.RectangleF(0, 0, $size, $size)
  if ($dark) {
    $g.Clear([System.Drawing.Color]::FromArgb(255, 11, 18, 38))
  } else {
    $brush = New-GradientBrush $rect 45
    $g.FillRectangle($brush, $rect)
    $brush.Dispose()
  }
  # centered P + brand text
  $fontP = New-Object System.Drawing.Font('Segoe UI', [float]($size * 0.16), [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
  $fontT = New-Object System.Drawing.Font('Segoe UI', [float]($size * 0.045), [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
  $sfC = New-Object System.Drawing.StringFormat
  $sfC.Alignment = [System.Drawing.StringAlignment]::Center
  $sfC.LineAlignment = [System.Drawing.StringAlignment]::Center
  $rectP = New-Object System.Drawing.RectangleF(0, ($size * 0.30), $size, ($size * 0.24))
  $g.DrawString('P', $fontP, [System.Drawing.Brushes]::White, $rectP, $sfC)
  $rectT = New-Object System.Drawing.RectangleF(0, ($size * 0.56), $size, ($size * 0.06))
  $g.DrawString('PDFMate', $fontT, [System.Drawing.Brushes]::White, $rectT, $sfC)
  $fontP.Dispose(); $fontT.Dispose(); $sfC.Dispose()
  $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose(); $bmp.Dispose()
  Write-Output ('SPLASH ' + $path)
}

# icon-only: full-bleed square for iOS (system applies mask)
Save-Icon (Join-Path $OutDir 'icon-only.png') 1024 $false 0.55
# adaptive foreground: transparent bg + P inside safe zone
Save-Icon (Join-Path $OutDir 'icon-foreground.png') 1024 $true 0.50
# adaptive background: full-bleed gradient
Save-Icon (Join-Path $OutDir 'icon-background.png') 1024 $false 0
Save-Splash (Join-Path $OutDir 'splash.png') 2732 $false
Save-Splash (Join-Path $OutDir 'splash-dark.png') 2732 $true
# legacy iOS pair referenced by the Capacitor template AppIcon.appiconset
$iosDir = Join-Path $OutDir 'ios'
New-Item -ItemType Directory -Force $iosDir | Out-Null
Save-Icon (Join-Path $iosDir 'AppIcon60x60@2x.png') 120 $false 0.55
Save-Icon (Join-Path $iosDir 'AppIcon76x76@2x~ipad.png') 152 $false 0.55
Write-Output DONE
