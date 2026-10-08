@echo off
title O Jailbreak
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 goto nonode

if not exist ".env" > ".env" echo DISCORD_TOKEN=paste-your-bot-token-here
findstr /c:"DISCORD_TOKEN=paste-your-bot-token-here" ".env" >nul 2>nul
if not errorlevel 1 goto needtoken

if not exist "node_modules\discord.js\package.json" (
  echo Installing O Jailbreak for the first time - this takes a minute...
  call npm install --omit=dev --no-audit --no-fund
  if errorlevel 1 goto failed
)

:run
echo Starting O Jailbreak...
node index.js
if errorlevel 2 goto failed
echo.
echo O Jailbreak stopped. Restarting in 5 seconds - close this window to turn it off.
timeout /t 5 /nobreak >nul
goto run

:nonode
echo Node.js is not installed. Download the LTS version from https://nodejs.org and then run start.bat again.
pause
exit /b 1

:needtoken
echo Notepad is opening a file called .env - replace paste-your-bot-token-here with your bot token, save it, then run start.bat again.
notepad ".env"
pause
exit /b 1

:failed
echo.
echo O Jailbreak can't start - read the message above to see what to fix.
pause
exit /b 1
