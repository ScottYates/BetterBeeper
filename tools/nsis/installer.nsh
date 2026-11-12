; Custom NSIS script for the installer.
;
; It is included in both the installer and the uninstaller, and it does one
; thing: it makes an update install over the top of the old version instead
; of uninstalling it first.
;
; Why that matters, measured rather than assumed:
;
; The uninstaller is what deletes the Start Menu shortcut and unregisters the
; app's identity (its AppUserModelId). The taskbar pin is the shell's entry
; for that identity, so an update that uninstalls the old version takes the
; pin with it, and the app has to be pinned by hand again - which is exactly
; what was reported.
;
; Quitting the uninstaller before it deletes anything means the install goes
; over the top: the new files are written over the old ones, the shortcut is
; left exactly as it was, and the identity is never unregistered, so the shell
; is never given a reason to touch the pin.
;
; The old files that are no longer part of the new version are left behind.
; That is the trade: a file the new version dropped stays on disk rather than
; being removed. It costs a few hundred kilobytes and it is worth it for
; leaving the user's own settings alone.
;
; The installer is also given "--updated" when it is launched (see the update
; helper), which is what makes it an update rather than a fresh install. That
; is a separate thing and it matters separately: it is what makes the
; installer keep the Start Menu shortcut instead of rewriting it, and what
; makes it pass "--keep-shortcuts" on to the uninstaller it would otherwise
; run.
!macro customUnInstall
  ; The old version is not uninstalled. The installer goes on to write the
  ; new files over the old ones, and nothing the uninstaller would have done
  ; to the shortcuts or to the app's identity happens.
  ;
  ; The exit code is set first, because the installer checks it: it runs the
  ; old uninstaller and carries on only if it succeeded.
  SetErrorLevel 0
  Quit
!macroend
