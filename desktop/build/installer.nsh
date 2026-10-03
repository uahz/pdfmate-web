# NSIS installer customization: Windows Explorer context menu (ASCII-safe English label)
!macro customInstall
  WriteRegStr HKCR "*\shell\PDFMate" "MUIVerb" "Convert with PDFMate"
  WriteRegStr HKCR "*\shell\PDFMate" "Icon" "$INSTDIR\PDFMate.exe"
  WriteRegStr HKCR "*\shell\PDFMate\command" "" '$\"$INSTDIR\PDFMate.exe$\" $\"%1$\"'
!macroend
!macro customUnInstall
  DeleteRegKey HKCR "*\shell\PDFMate"
!macroend
