; Runtime fixture: only writes to a disposable test subkey supplied at compile time.
Unicode true
!include LogicLib.nsh
!include StrFunc.nsh
${StrLoc}
!ifndef TEST_KEY
  !error "TEST_KEY must name a disposable HKCU test subkey"
!endif
!define PRODUCTNAME "nteract PATH regression fixture"
!include "bootstrap.nsh"

Name "nteract PATH regression fixture"
OutFile "test-user-path.exe"
RequestExecutionLevel user
SilentInstall silent

Section
  WriteRegDWORD HKCU "${TEST_KEY}" "StringLimit" ${NSIS_MAX_STRLEN}
  !insertmacro NTERACT_APPEND_USER_PATH "${TEST_KEY}" "C:\nteract-path-test\bin"
SectionEnd
