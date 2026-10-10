@echo off
setlocal

set "ROOT=E:\Cliro"
set "OLLAMA_EXE=%LOCALAPPDATA%\Programs\Ollama\ollama.exe"

if not exist "%ROOT%\backend\dist\index.js" (
    echo ERROR: Backend build is missing. Run npm run build in %ROOT%\backend.
    exit /b 1
)
if not exist "%ROOT%\frontend\node_modules\.bin\vite.cmd" (
    echo ERROR: Frontend dependencies are missing in %ROOT%\frontend.
    exit /b 1
)

echo Checking Ollama at http://localhost:11434 ...
call :PROBE_OLLAMA
if not errorlevel 1 goto OLLAMA_READY
if errorlevel 3 goto OLLAMA_UNRESPONSIVE
if errorlevel 2 goto PORT_CONFLICT

if not exist "%OLLAMA_EXE%" (
    echo ERROR: Existing Ollama executable was not found at "%OLLAMA_EXE%".
    exit /b 1
)
echo Starting the existing Ollama installation...
start "CLIRO Ollama" /min "%OLLAMA_EXE%" serve
call :WAIT_OLLAMA
if errorlevel 1 (
    echo ERROR: Ollama did not become healthy at http://localhost:11434/api/tags.
    exit /b 1
)

:OLLAMA_READY
echo Ollama is healthy.

echo Checking CLIRO backend at http://localhost:3001 ...
call :PROBE_BACKEND
if not errorlevel 1 goto BACKEND_READY
if errorlevel 2 goto PORT_CONFLICT

echo Starting CLIRO backend...
start "CLIRO Backend" /min "%ComSpec%" /c "cd /d ""%ROOT%\backend"" && npm start"
call :WAIT_BACKEND
if errorlevel 1 (
    echo ERROR: Backend did not become healthy at http://localhost:3001/api/status.
    call :REPORT_PORT 3001
    exit /b 1
)

:BACKEND_READY
echo CLIRO backend is healthy.

echo Checking CLIRO frontend at http://localhost:5173 ...
call :PROBE_FRONTEND
if not errorlevel 1 goto FRONTEND_READY
if errorlevel 2 goto PORT_CONFLICT

echo Starting CLIRO frontend...
start "CLIRO Frontend" /min "%ComSpec%" /c "cd /d ""%ROOT%\frontend"" && npm run dev"
call :WAIT_FRONTEND
if errorlevel 1 (
    echo ERROR: Frontend did not become healthy at http://localhost:5173.
    call :REPORT_PORT 5173
    exit /b 1
)

:FRONTEND_READY
echo CLIRO frontend is healthy.
echo.
echo CLIRO READY
echo Backend: http://localhost:3001
echo Frontend: http://localhost:5173
echo Ollama: http://localhost:11434
if /i "%~1"=="--open-browser" start "" "http://localhost:5173"
exit /b 0

:PROBE_OLLAMA
powershell.exe -NoProfile -Command "$ErrorActionPreference='SilentlyContinue'; try {$r=Invoke-RestMethod -Uri 'http://127.0.0.1:11434/api/tags' -TimeoutSec 3; if ($r.models -is [array]) { exit 0 }} catch {}; $c=Get-NetTCPConnection -LocalPort 11434 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1; if ($c) {$p=Get-CimInstance Win32_Process -Filter ('ProcessId = '+$c.OwningProcess); Write-Output ('ERROR: Port 11434 is occupied by PID '+$c.OwningProcess+' ('+$p.Name+'): '+$p.CommandLine); exit 2}; if (Get-Process -Name 'ollama','ollama app' -ErrorAction SilentlyContinue) {Write-Output 'ERROR: An Ollama process is already running but the API is not responding; refusing to start a duplicate.'; exit 3}; exit 1"
exit /b %errorlevel%

:PROBE_BACKEND
powershell.exe -NoProfile -Command "$ErrorActionPreference='SilentlyContinue'; try {$r=Invoke-RestMethod -Uri 'http://127.0.0.1:3001/api/status' -TimeoutSec 3; if ($r.status -eq 'online') { exit 0 }} catch {}; $c=Get-NetTCPConnection -LocalPort 3001 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1; if ($c) {$p=Get-CimInstance Win32_Process -Filter ('ProcessId = '+$c.OwningProcess); Write-Output ('ERROR: Port 3001 is occupied by PID '+$c.OwningProcess+' ('+$p.Name+'): '+$p.CommandLine); exit 2}; exit 1"
exit /b %errorlevel%

:PROBE_FRONTEND
powershell.exe -NoProfile -Command "$ErrorActionPreference='SilentlyContinue'; try {$r=Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:5173/' -TimeoutSec 3; if ($r.StatusCode -eq 200 -and $r.Content -match 'CLIRO') { exit 0 }} catch {}; $c=Get-NetTCPConnection -LocalPort 5173 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1; if ($c) {$p=Get-CimInstance Win32_Process -Filter ('ProcessId = '+$c.OwningProcess); Write-Output ('ERROR: Port 5173 is occupied by PID '+$c.OwningProcess+' ('+$p.Name+'): '+$p.CommandLine); exit 2}; exit 1"
exit /b %errorlevel%

:WAIT_OLLAMA
for /l %%i in (1,1,45) do (
    powershell.exe -NoProfile -Command "try {$r=Invoke-RestMethod -Uri 'http://127.0.0.1:11434/api/tags' -TimeoutSec 3; if ($r.models -is [array]) { exit 0 }} catch {}; exit 1"
    if not errorlevel 1 exit /b 0
    timeout /t 2 /nobreak >nul
)
exit /b 1

:WAIT_BACKEND
for /l %%i in (1,1,45) do (
    powershell.exe -NoProfile -Command "try {$r=Invoke-RestMethod -Uri 'http://127.0.0.1:3001/api/status' -TimeoutSec 3; if ($r.status -eq 'online') { exit 0 }} catch {}; exit 1"
    if not errorlevel 1 exit /b 0
    timeout /t 2 /nobreak >nul
)
exit /b 1

:WAIT_FRONTEND
for /l %%i in (1,1,45) do (
    powershell.exe -NoProfile -Command "try {$r=Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:5173/' -TimeoutSec 3; if ($r.StatusCode -eq 200 -and $r.Content -match 'CLIRO') { exit 0 }} catch {}; exit 1"
    if not errorlevel 1 exit /b 0
    timeout /t 2 /nobreak >nul
)
exit /b 1

:REPORT_PORT
powershell.exe -NoProfile -Command "$c=Get-NetTCPConnection -LocalPort %1 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1; if ($c) {$p=Get-CimInstance Win32_Process -Filter ('ProcessId = '+$c.OwningProcess); Write-Output ('Port %1 listener: PID '+$c.OwningProcess+' ('+$p.Name+'): '+$p.CommandLine)} else {Write-Output 'No listener currently owns port %1.'}"
exit /b 0

:PORT_CONFLICT
echo.
echo Startup stopped because a required local port is occupied. See the conflict above.
exit /b 1

:OLLAMA_UNRESPONSIVE
echo.
echo Startup stopped: Ollama is already running but its API is not responding. No duplicate was started.
exit /b 1
