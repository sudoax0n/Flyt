@echo off
cd /d "%~dp0"
echo ===================================================
echo   Flyt Native Windows Modal Authentication Setup
echo ===================================================
echo.
echo Launching browser to link Windows with Modal...
"..\source app folder\tracker\venv\Scripts\modal.exe" setup
pause
