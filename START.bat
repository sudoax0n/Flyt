@echo off
title Flyt
cd /d "%~dp0source app folder\dashboard"
echo.
echo  Flyt - starting dashboard + API
echo  Open http://localhost:5173 when ready
echo.
npm run dev