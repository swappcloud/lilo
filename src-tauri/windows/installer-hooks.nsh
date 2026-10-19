; Tauri removes its matching shortcuts before this hook runs.
; Notify Explorer that the desktop folder changed, including redirected paths.
!macro NSIS_HOOK_POSTUNINSTALL
  ${If} $UpdateMode <> 1
    ; SHCNE_UPDATEDIR, SHCNF_PATHW | SHCNF_FLUSHNOWAIT.
    System::Call 'shell32::SHChangeNotify(i 0x00001000, i 0x00002005, w "$DESKTOP", p 0)'
  ${EndIf}
!macroend
