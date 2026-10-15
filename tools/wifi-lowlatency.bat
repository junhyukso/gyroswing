@echo off
rem GyroSword: lower Wi-Fi latency on this PC (MediaTek Wi-Fi adapter named "Wi-Fi").
rem   wifi-lowlatency.bat          adapter Power Saving -> Disabled, roaming aggressiveness -> Lowest
rem   wifi-lowlatency.bat revert   back to the previous values (Power Saving Auto, roaming Medium-High)
rem Asks for administrator rights. Wi-Fi reconnects for a few seconds when it is applied.

net session >nul 2>&1
if errorlevel 1 (
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -ArgumentList '%1' -Verb RunAs"
  exit /b
)

if /i "%1"=="revert" (
  set POWER=1
  set ROAM=70
  echo Restoring: Power Saving = Auto, roaming = Medium-High
) else (
  set POWER=0
  set ROAM=85
  echo Applying: Power Saving = Disabled, roaming = Lowest
)

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "Set-NetAdapterAdvancedProperty -Name 'Wi-Fi' -RegistryKeyword 'LowPowerEnable' -RegistryValue %POWER%;" ^
  "Set-NetAdapterAdvancedProperty -Name 'Wi-Fi' -RegistryKeyword 'RoamNeedIndicateTh' -RegistryValue %ROAM%;" ^
  "Get-NetAdapterAdvancedProperty -Name 'Wi-Fi' -RegistryKeyword 'LowPowerEnable','RoamNeedIndicateTh' | Format-Table DisplayName, DisplayValue -AutoSize"

echo.
echo Done. Wi-Fi may reconnect for a few seconds - then reload the game page and the phone page.
pause
