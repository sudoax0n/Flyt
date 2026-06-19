@echo off
chcp 65001 >nul
set PYTHONIOENCODING=utf-8
cd /d "%~dp0"
set VIDEO_LOCAL=..\assets\fly_video.mp4
set CSV_DOWNLOADED=results\modal_parity_test.csv
set GOLD_PITCH_CSV=E:\prasad-pitch\source app folder\tracker\fly_tracking_data.csv

echo ===================================================
echo   Flyt Modal Run-Parity Checker (0-Diff Gate)
echo ===================================================
echo.

echo Executing remote tracking on Modal...
"..\source app folder\tracker\venv\Scripts\python.exe" -m modal run scripts\run_modal.py --video-path "%VIDEO_LOCAL%" --output-csv "%CSV_DOWNLOADED%"
if errorlevel 1 goto :fail

echo.
echo ===================================================
echo   Validating Modal Output vs. Gold Pitch CSV
echo ===================================================
"..\source app folder\tracker\venv\Scripts\python.exe" scripts\csv_validator.py --candidate "%CSV_DOWNLOADED%" --gold "%GOLD_PITCH_CSV%"
if errorlevel 1 (
    echo.
    echo FAIL: Modal output mismatches Gold Pitch CSV!
    goto :end
)

echo.
echo PASS: Modal output matches Gold Pitch CSV (within RMSE limits)!
goto :end

:fail
echo.
echo RUN-MODAL-PARITY execution failed.

:end
echo %cmdcmdline% | find /i "%~0" >nul
if not errorlevel 1 pause
exit /b %errorlevel%

