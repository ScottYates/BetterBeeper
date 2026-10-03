# Dev helper: write the sample image the copy-image live check uses.
# Kept out of git so the repository carries no binary test fixture.
Add-Type -AssemblyName System.Drawing

$out = Join-Path $PSScriptRoot '.copy-sample.png'
$bmp = New-Object System.Drawing.Bitmap 120, 80
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.Clear([System.Drawing.Color]::FromArgb(30, 110, 200))
$font = New-Object System.Drawing.Font('Arial', 14, [System.Drawing.FontStyle]::Bold)
$g.DrawString('COPY', $font, [System.Drawing.Brushes]::White, 26, 28)
$g.Dispose()
$font.Dispose()
$bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()

Write-Output ("wrote " + $out + " (120x80)")
