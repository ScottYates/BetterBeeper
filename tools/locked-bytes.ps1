# Scratch: how many bytes in these folders can be deleted right now.
#
# The prune tool empties an old build directory and leaves behind whatever
# another program is holding open. The check that watches the disk has to
# know the difference between "an old build is sitting there" and "the one
# file in an old build is held open", because the first is a problem and the
# second is not: nothing can be done about it until the handle is released.
#
# The test is the one Windows itself uses. A file can only be deleted if
# every handle on it was opened with FILE_SHARE_DELETE, so asking for DELETE
# access to it answers exactly the question "can this be removed?".
# Asking for read access instead would not: a file can be perfectly
# readable and perfectly undeletable at the same time.
#
# The question is asked without touching the file. Nothing is renamed,
# nothing is moved and nothing is deleted; the handle is opened for DELETE
# access and closed again, and if it cannot even be opened then the answer
# is no.
#
# The folders are read from stdin, one path per line, and two numbers come
# back on stdout:
#
#   removable <bytes>   the bytes a prune could take away now
#   locked <bytes>      the bytes it cannot, because something holds them
#
# Run with: pwsh -NoProfile -File tools/locked-bytes.ps1
param()

$ErrorActionPreference = 'Stop'

$src = @"
using System;
using System.Runtime.InteropServices;

public static class DeleteProbe
{
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateFileW(string name, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr handle);

    private const uint DELETE = 0x00010000;
    private const uint SHARE_ALL = 0x00000007;
    private const uint OPEN_EXISTING = 3;
    private const uint FILE_ATTRIBUTE_NORMAL = 0x00000080;

    /// Can this file be deleted right now?
    public static bool CanDelete(string path)
    {
        IntPtr handle = CreateFileW(path, DELETE, SHARE_ALL, IntPtr.Zero, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, IntPtr.Zero);
        if (handle == IntPtr.Zero || handle.ToInt64() == -1)
        {
            return false;
        }
        CloseHandle(handle);
        return true;
    }
}
"@

Add-Type -TypeDefinition $src -Language CSharp

$removable = 0
$locked = 0
$files = 0

$paths = [System.Collections.Generic.List[string]]::new()
foreach ($line in [Console]::In.ReadToEnd().Split("`n")) {
    # A pipe from another PowerShell writes a byte order mark at the start of
    # the first line, and a path with a mark on the front is a path that does
    # not exist.
    $trimmed = $line.TrimStart([char]0xFEFF).Trim()
    if ($trimmed) { $paths.Add($trimmed) }
}

foreach ($p in $paths) {
    if (-not (Test-Path -LiteralPath $p)) { continue }
    $items = Get-ChildItem -LiteralPath $p -Recurse -File -Force -ErrorAction SilentlyContinue
    foreach ($item in $items) {
        $files++
        $size = $item.Length
        if ([DeleteProbe]::CanDelete($item.FullName)) {
            $removable += $size
        } else {
            $locked += $size
        }
    }
}

Write-Output "removable $removable"
Write-Output "locked $locked"
Write-Output "files $files"
