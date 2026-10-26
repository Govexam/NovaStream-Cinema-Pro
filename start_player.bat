@echo off
title NovaStream Cinema Pro
color 0B
echo ========================================================
echo        STARTING NOVASTREAM CINEMA PRO (LIVE TV)
echo ========================================================
echo.
cd /d "%~dp0"
echo Starting proxy server on http://localhost:5000 ...
start "" http://localhost:5000
python server.py
pause
