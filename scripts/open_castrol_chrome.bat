@echo off
REM Opens the Castrol DigiClaim portal in a Chrome window that the autofill script can control.
REM Log in here once; the login is remembered in this profile for next time.
start "" "C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222 --user-data-dir="%USERPROFILE%\.castrol_digiclaim_profile" "https://castroldigiclaim.com/WorkSteps/NDCApproval"
