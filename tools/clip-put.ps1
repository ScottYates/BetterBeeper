# Dev helper: put a real PNG on the Windows clipboard so the paste path can be
# tested with a genuine Ctrl+V instead of a synthetic clipboard event.
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$bmp = New-Object System.Drawing.Bitmap 96, 64
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.Clear([System.Drawing.Color]::FromArgb(0, 168, 207))
$font = New-Object System.Drawing.Font('Arial', 18, [System.Drawing.FontStyle]::Bold)
$g.DrawString('PASTE', $font, [System.Drawing.Brushes]::Black, 8, 20)
$g.Dispose()
$font.Dispose()

[System.Windows.Forms.Clipboard]::SetImage($bmp)
Start-Sleep -Milliseconds 400

$back = [System.Windows.Forms.Clipboard]::GetImage()
if ($null -eq $back) {
    Write-Output 'clipboard does not hold an image'
    exit 1
}
Write-Output ("clipboard holds an image: " + $back.Width + "x" + $back.Height)
$bmp.Dispose()
$back.Dispose()
