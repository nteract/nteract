!define NTERACT_SHIM_MARKER "nteract-managed-cli-shim v1"
!define NTERACT_HWND_BROADCAST 0xffff
!define NTERACT_WM_SETTINGCHANGE 0x001A
${StrRep}
${UnStrRep}

Var NteractCliTarget
Var NteractCliSelected
Var NteractCliPreviousChannel
Var NteractCliEscapedTarget
Var NteractCliOwned

; Records are shared with the Rust desktop installer and may use LF or CRLF.
!macro NTERACT_READ_CLI_TARGET RECORD_PATH OUTPUT
  StrCpy ${OUTPUT} ""
  ClearErrors
  FileOpen $R3 "${RECORD_PATH}" r
  ${IfNot} ${Errors}
    FileRead $R3 ${OUTPUT}
    FileClose $R3
    ${Do}
      StrCpy $R2 ${OUTPUT} 1 -1
      ${If} $R2 == "$\r"
      ${OrIf} $R2 == "$\n"
        StrCpy ${OUTPUT} ${OUTPUT} -1
      ${Else}
        ${ExitDo}
      ${EndIf}
    ${Loop}
  ${EndIf}
!macroend

; Match the full generated shim, not just a comment that could survive edits.
!macro NTERACT_CHECK_CANONICAL_SHIM CLI_DIR
  StrCpy $NteractCliOwned "0"
  ClearErrors
  FileOpen $R3 "${CLI_DIR}\nteract.cmd" r
  ${IfNot} ${Errors}
    FileRead $R3 $R2
    ${If} $R2 == "@echo off$\r$\n"
      FileRead $R3 $R2
      ${If} $R2 == "rem ${NTERACT_SHIM_MARKER}$\r$\n"
        FileRead $R3 $R2
        ${If} $R2 == "$\"$NteractCliEscapedTarget$\" %*$\r$\n"
          ClearErrors
          FileRead $R3 $R2
          ${If} ${Errors}
            StrCpy $NteractCliOwned "1"
          ${EndIf}
        ${EndIf}
      ${EndIf}
    ${EndIf}
    FileClose $R3
  ${EndIf}
!macroend

!macro NTERACT_INSTALL_CANONICAL_CLI
  StrCpy $NteractCliTarget "$INSTDIR\nteract-cli.exe"
  !insertmacro NTERACT_READ_CLI_TARGET "$R6\.nteract-cli-target" $NteractCliSelected
  !insertmacro NTERACT_READ_CLI_TARGET "$R6\.nteract-cli-$R9-target" $NteractCliPreviousChannel
  ClearErrors
  FileOpen $R3 "$R6\.nteract-cli-$R9-target" w
  ${IfNot} ${Errors}
    FileWrite $R3 "$NteractCliTarget$\r$\n"
    FileClose $R3
  ${EndIf}
  StrCpy $NteractCliOwned "1"
  ${If} ${FileExists} "$R6\nteract.cmd"
    ${StrRep} $NteractCliEscapedTarget "$NteractCliSelected" "%" "%%"
    !insertmacro NTERACT_CHECK_CANONICAL_SHIM "$R6"
    ${If} $NteractCliSelected != $NteractCliTarget
    ${AndIf} $NteractCliSelected != $NteractCliPreviousChannel
      StrCpy $NteractCliOwned "0"
    ${EndIf}
  ${EndIf}
  ${If} ${FileExists} "$R6\nteract.exe"
  ${OrIf} ${FileExists} "$R6\nteract.com"
  ${OrIf} ${FileExists} "$R6\nteract.bat"
    StrCpy $NteractCliOwned "0"
  ${EndIf}
  ${If} $NteractCliOwned == "1"
    ${StrRep} $NteractCliEscapedTarget "$NteractCliTarget" "%" "%%"
    !insertmacro NTERACT_WRITE_SHIM "$R6\nteract.cmd" "$\"$NteractCliEscapedTarget$\" %*"
    ; Record selection only when the resulting shim matches this target.
    !insertmacro NTERACT_CHECK_CANONICAL_SHIM "$R6"
    ${If} $NteractCliOwned == "1"
      ClearErrors
      FileOpen $R3 "$R6\.nteract-cli-target" w
      ${IfNot} ${Errors}
        FileWrite $R3 "$NteractCliTarget$\r$\n"
        FileClose $R3
      ${EndIf}
    ${EndIf}
  ${Else}
    !insertmacro NTERACT_APPEND_BOOTSTRAP_LOG "Preserved existing nteract command or other channel selection. CLI available at $NteractCliTarget"
  ${EndIf}
!macroend

!macro NTERACT_REMOVE_CANONICAL_CLI CLI_DIR
  StrCpy $NteractCliTarget "$INSTDIR\nteract-cli.exe"
  !insertmacro NTERACT_READ_CLI_TARGET "${CLI_DIR}\.nteract-cli-target" $NteractCliSelected
  ${If} $NteractCliSelected == $NteractCliTarget
    ${UnStrRep} $NteractCliEscapedTarget "$NteractCliTarget" "%" "%%"
    !insertmacro NTERACT_CHECK_CANONICAL_SHIM "${CLI_DIR}"
    ${If} $NteractCliOwned == "1"
      Delete "${CLI_DIR}\nteract.cmd"
      Delete "${CLI_DIR}\.nteract-cli-target"
    ${EndIf}
  ${EndIf}
  !insertmacro NTERACT_READ_CLI_TARGET "${CLI_DIR}\.nteract-cli-$R9-target" $NteractCliPreviousChannel
  ${If} $NteractCliPreviousChannel == $NteractCliTarget
    Delete "${CLI_DIR}\.nteract-cli-$R9-target"
  ${EndIf}
!macroend

!macro NTERACT_SET_CHANNEL_VALUES
  StrCpy $R9 "stable"
  StrCpy $R8 "runt"
  StrCpy $R7 "nb"
  ${If} "${PRODUCTNAME}" == "nteract Nightly"
    StrCpy $R9 "nightly"
    StrCpy $R8 "runt-nightly"
    StrCpy $R7 "nb-nightly"
  ${EndIf}
!macroend

!macro NTERACT_APPEND_BOOTSTRAP_LOG TEXT
  CreateDirectory "$LOCALAPPDATA\${PRODUCTNAME}"
  FileOpen $R0 "$LOCALAPPDATA\${PRODUCTNAME}\install-bootstrap.log" a
  ${IfNot} ${Errors}
    FileWrite $R0 "${TEXT}$\r$\n"
    FileClose $R0
  ${EndIf}
  DetailPrint "${TEXT}"
!macroend

!macro NTERACT_SELECT_CLI_DIR
  StrCpy $R6 ""
  StrCpy $R5 "$LOCALAPPDATA\Microsoft\WindowsApps"
  ${If} ${FileExists} "$R5\*.*"
    ReadEnvStr $R4 "PATH"
    ${StrLoc} $R3 "$R4" "$R5" ">"
    ${If} $R3 != ""
      ClearErrors
      FileOpen $R2 "$R5\.nteract-write-test.tmp" w
      ${IfNot} ${Errors}
        FileClose $R2
        Delete "$R5\.nteract-write-test.tmp"
        StrCpy $R6 "$R5"
      ${EndIf}
    ${EndIf}
  ${EndIf}

  ${If} $R6 == ""
    StrCpy $R6 "$PROFILE\.local\bin"
    CreateDirectory "$R6"
    ReadRegStr $R4 HKCU "Environment" "Path"
    ${StrLoc} $R3 "$R4" "$R6" ">"
    ${If} $R3 == ""
      ${If} $R4 == ""
        WriteRegExpandStr HKCU "Environment" "Path" "$R6"
      ${Else}
        WriteRegExpandStr HKCU "Environment" "Path" "$R4;$R6"
      ${EndIf}
      SendMessage ${NTERACT_HWND_BROADCAST} ${NTERACT_WM_SETTINGCHANGE} 0 "STR:Environment" /TIMEOUT=5000
    ${EndIf}
  ${EndIf}
!macroend

!macro NTERACT_WRITE_SHIM SHIM_PATH COMMAND_LINE
  StrCpy $R4 "1"
  ${If} ${FileExists} "${SHIM_PATH}"
    FileOpen $R3 "${SHIM_PATH}" r
    ${If} ${Errors}
      StrCpy $R4 "0"
    ${Else}
      FileRead $R3 $R2
      FileRead $R3 $R2
      FileClose $R3
      ${If} $R2 != "rem ${NTERACT_SHIM_MARKER}$\r$\n"
      ${AndIf} $R2 != "rem ${NTERACT_SHIM_MARKER}$\n"
        StrCpy $R4 "0"
      ${EndIf}
    ${EndIf}
  ${EndIf}

  ${If} $R4 == "1"
    ClearErrors
    FileOpen $R3 "${SHIM_PATH}" w
    ${If} ${Errors}
      !insertmacro NTERACT_APPEND_BOOTSTRAP_LOG "Failed to open shim for writing: ${SHIM_PATH}"
    ${Else}
      FileWrite $R3 "@echo off$\r$\n"
      FileWrite $R3 "rem ${NTERACT_SHIM_MARKER}$\r$\n"
      FileWrite $R3 "${COMMAND_LINE}$\r$\n"
      FileClose $R3
      !insertmacro NTERACT_APPEND_BOOTSTRAP_LOG "Wrote shim: ${SHIM_PATH}"
    ${EndIf}
  ${Else}
    !insertmacro NTERACT_APPEND_BOOTSTRAP_LOG "Skipped unmanaged shim: ${SHIM_PATH}"
  ${EndIf}
!macroend

!macro NTERACT_DELETE_OWNED_SHIM SHIM_PATH
  ${If} ${FileExists} "${SHIM_PATH}"
    FileOpen $R3 "${SHIM_PATH}" r
    ${IfNot} ${Errors}
      FileRead $R3 $R2
      FileRead $R3 $R2
      FileClose $R3
      ${If} $R2 == "rem ${NTERACT_SHIM_MARKER}$\r$\n"
      ${OrIf} $R2 == "rem ${NTERACT_SHIM_MARKER}$\n"
        Delete "${SHIM_PATH}"
      ${EndIf}
    ${EndIf}
  ${EndIf}
!macroend

!macro NSIS_HOOK_PREINSTALL
  !insertmacro NTERACT_SET_CHANNEL_VALUES
  ${If} ${FileExists} "$INSTDIR\uninstall.exe"
    ; The Tauri template also passes /UPDATE for updater-driven uninstalls.
    ; This registry flag covers the earlier pre-install phase where a prior
    ; install already exists but the uninstaller has not been invoked yet.
    WriteRegStr HKCU "Software\nteract\$R9\InstallState" "Updating" "1"
  ${EndIf}
!macroend

!macro NSIS_HOOK_POSTINSTALL
  !insertmacro NTERACT_SET_CHANNEL_VALUES
  CreateDirectory "$LOCALAPPDATA\${PRODUCTNAME}"
  Delete "$LOCALAPPDATA\${PRODUCTNAME}\install-bootstrap.log"
  !insertmacro NTERACT_APPEND_BOOTSTRAP_LOG "nteract installer bootstrap started"

  !insertmacro NTERACT_SELECT_CLI_DIR
  !insertmacro NTERACT_APPEND_BOOTSTRAP_LOG "CLI shim directory: $R6"
  !insertmacro NTERACT_WRITE_SHIM "$R6\$R8.cmd" "$\"$INSTDIR\runt.exe$\" %*"
  !insertmacro NTERACT_WRITE_SHIM "$R6\$R7.cmd" "$\"$INSTDIR\runt.exe$\" notebook %*"
  !insertmacro NTERACT_INSTALL_CANONICAL_CLI

  ; Run daemon doctor --fix --no-start. This installs the daemon binary and
  ; writes the Startup folder VBS entry (so the daemon auto-starts at login)
  ; but does NOT spawn the daemon process itself. Spawning a long-running
  ; daemon here would leave it inside the installer's Windows Job Object:
  ; the GHA Actions runner (and PowerShell's Start-Process -Wait) waits for
  ; the entire Job to drain before the step completes, causing a 75-minute
  ; timeout on every CI run. The daemon will start at next user login instead.
  nsExec::ExecToStack '"$INSTDIR\runt.exe" daemon doctor --fix --no-start'
  Pop $R5
  Pop $R4
  !insertmacro NTERACT_APPEND_BOOTSTRAP_LOG "$R4"

  ${If} $R5 != 0
    !insertmacro NTERACT_APPEND_BOOTSTRAP_LOG "Daemon bootstrap failed with exit code $R5"
    ${If} ${Silent}
    ${OrIf} $PassiveMode = 1
      SetErrorLevel 1
      Abort "nteract bootstrap failed; see $LOCALAPPDATA\${PRODUCTNAME}\install-bootstrap.log"
    ${Else}
      MessageBox MB_ICONEXCLAMATION "nteract installed, but daemon setup failed. Details: $LOCALAPPDATA\${PRODUCTNAME}\install-bootstrap.log"
    ${EndIf}
  ${Else}
    !insertmacro NTERACT_APPEND_BOOTSTRAP_LOG "Daemon bootstrap complete"
  ${EndIf}

  DeleteRegValue HKCU "Software\nteract\$R9\InstallState" "Updating"
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  !insertmacro NTERACT_SET_CHANNEL_VALUES
  ReadRegStr $R6 HKCU "Software\nteract\$R9\InstallState" "Updating"
  ${If} $UpdateMode = 1
  ${OrIf} $R6 == "1"
    DetailPrint "Skipping nteract daemon and shim removal during update"
  ${Else}
    nsExec::ExecToLog '"$INSTDIR\runt.exe" daemon uninstall'
    !insertmacro NTERACT_DELETE_OWNED_SHIM "$LOCALAPPDATA\Microsoft\WindowsApps\$R8.cmd"
    !insertmacro NTERACT_DELETE_OWNED_SHIM "$LOCALAPPDATA\Microsoft\WindowsApps\$R7.cmd"
    !insertmacro NTERACT_DELETE_OWNED_SHIM "$PROFILE\.local\bin\$R8.cmd"
    !insertmacro NTERACT_DELETE_OWNED_SHIM "$PROFILE\.local\bin\$R7.cmd"
    !insertmacro NTERACT_REMOVE_CANONICAL_CLI "$LOCALAPPDATA\Microsoft\WindowsApps"
    !insertmacro NTERACT_REMOVE_CANONICAL_CLI "$PROFILE\.local\bin"
  ${EndIf}
!macroend
