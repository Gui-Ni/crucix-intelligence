@echo off
:: Guard: only run if not already running
tasklist /fi "IMAGENAME eq node.exe" /fo csv 2>nul | findstr /c:"node.exe" >nul
if %errorlevel%==0 (
    :: Check if crucix is already in PM2
    call npx pm2 jlist >nul 2>&1
    if %errorlevel%==0 (
        echo Crucix is already running, skipping start.
        exit /b
    )
)
cd /d C:\Users\admin\.openclaw\workspace\projects\Crucix
call npx pm2 resurrect
