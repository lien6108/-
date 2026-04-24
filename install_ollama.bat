@echo off
echo Installing Ollama...
winget install Ollama.Ollama --accept-package-agreements --accept-source-agreements
echo Done. Exit code: %ERRORLEVEL%
pause
