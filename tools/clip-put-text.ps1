# Dev helper: put plain text on the Windows clipboard, so the paste path can be
# checked for the regression that matters most - swallowing ordinary text pastes.
Add-Type -AssemblyName System.Windows.Forms

$text = 'pasted text 123'
[System.Windows.Forms.Clipboard]::SetText($text)
Start-Sleep -Milliseconds 400

$back = [System.Windows.Forms.Clipboard]::GetText()
if ($back -ne $text) {
    Write-Output ("clipboard text mismatch: " + $back)
    exit 1
}
Write-Output ("clipboard holds text: " + $back)
