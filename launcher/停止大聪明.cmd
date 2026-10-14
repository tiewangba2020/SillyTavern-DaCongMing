@echo off
chcp 65001 >nul
setlocal EnableExtensions
title 大聪明 · 停止本地服务

set "ROOT=%~dp0.."
for %%I in ("%ROOT%") do set "ROOT=%%~fI"
set "RUNTIME=%ROOT%\server\data\runtime.json"
set "NODE_EXE=node"
if exist "%ROOT%\runtime\node\node.exe" set "NODE_EXE=%ROOT%\runtime\node\node.exe"

if not exist "%RUNTIME%" (
    echo  未找到运行时记录（%RUNTIME%），服务可能未启动。
    pause
    exit /b 0
)

for /f "usebackq delims=" %%p in (`"%NODE_EXE%" -p "try{const r=require(process.argv[1]);r.stoppedAt?'':String(r.pid)}catch{''}" "%RUNTIME%"`) do set "SVC_PID=%%p"

if not defined SVC_PID (
    echo  服务未在运行（或已停止）。
    pause
    exit /b 0
)

echo  正在停止大聪明服务（PID %SVC_PID%）……
taskkill /PID %SVC_PID% /T >nul 2>nul
timeout /t 2 /nobreak >nul
tasklist /FI "PID eq %SVC_PID%" 2>nul | find "%SVC_PID%" >nul
if not errorlevel 1 (
    echo  进程仍在运行，强制结束……
    taskkill /PID %SVC_PID% /T /F >nul 2>nul
)
echo  已停止。停止服务不会删除聊天或记忆数据（SQLite WAL 会在下次启动时自动恢复）。
pause
endlocal
