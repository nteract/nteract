; Runtime fixture: only writes to a disposable test subkey supplied at compile time.
Unicode true
!include LogicLib.nsh
!include StrFunc.nsh
${StrLoc}
!ifndef TEST_KEY
  !error "TEST_KEY must name a disposable HKCU test subkey"
!endif
!ifndef PRODUCTNAME
  !define PRODUCTNAME "nteract PATH regression fixture"
!endif
!include "bootstrap.nsh"

Name "nteract PATH regression fixture"
OutFile "test-user-path.exe"
RequestExecutionLevel user
SilentInstall silent

Section
  ; Logging must work when called from a failed installer operation.
  SetErrors
  !insertmacro NTERACT_APPEND_BOOTSTRAP_LOG "PATH fixture started"
  WriteRegDWORD HKCU "${TEST_KEY}" "StringLimit" ${NSIS_MAX_STRLEN}
  !insertmacro NTERACT_APPEND_USER_PATH "${TEST_KEY}" "C:\nteract-path-test\bin"
  !insertmacro NTERACT_APPEND_BOOTSTRAP_LOG "PATH fixture complete"
SectionEnd
