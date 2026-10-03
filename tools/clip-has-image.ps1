# Dev helper: report whether the Windows clipboard currently holds an image.
# Exits 0 and prints "image WxH" when it does, 1 otherwise.
Add-Type -AssemblyName System.Windows.Forms

if (-not [System.Windows.Forms.Clipboard]::ContainsImage()) {
    Write-Output 'no-image'
    exit 1
}
$img = [System.Windows.Forms.Clipboard]::GetImage()
Write-Output ("image " + $img.Width + "x" + $img.Height)
$img.Dispose()
