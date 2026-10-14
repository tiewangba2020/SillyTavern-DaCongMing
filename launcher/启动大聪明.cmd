@echo off
chcp 65001 >nul
setlocal EnableExtensions
title 大聪明 · 记忆管理与上下文压缩 · 本地服务

set "ROOT=%~dp0.."
for %%I in ("%ROOT%") do set "ROOT=%%~fI"
set "NODE_EXE="

rem 1) 优先使用随包携带的便携 Node（runtime\node\node.exe），其次使用系统 Node
if exist "%ROOT%\runtime\node\node.exe" set "NODE_EXE=%ROOT%\runtime\node\node.exe"
if not defined NODE_EXE (
    where node >nul 2>nul
    if not errorlevel 1 set "NODE_EXE=node"
)

if not defined NODE_EXE (
    echo.
    echo  [需要处理] 未找到 Node.js 运行时。
    echo    修复方式 1：安装 Node.js 22.5 或更新版本（https://nodejs.org/）后重新运行本脚本。
    echo    修复方式 2：下载 Node.js 便携版，解压到：
    echo        %ROOT%\runtime\node\   （目录内应包含 node.exe）
    echo.
    pause
    exit /b 1
)

rem 2) 版本检查：>=22.5 启用内置 SQLite 权威存储；18~22.4 可运行但使用降级存储；<18 不支持
"%NODE_EXE%" -e "const [a,b]=process.versions.node.split('.').map(Number);process.exit(a>22||(a===22&&b>=5)?0:(a>=18?2:1))"
set "NODE_STATUS=%errorlevel%"
if "%NODE_STATUS%"=="1" (
    echo.
    echo  [需要处理] Node.js 版本过低（需要 18 以上，推荐 22.5+）。
    echo    修复方式：安装 Node.js 22.5 或更新版本（https://nodejs.org/）。
    echo.
    pause
    exit /b 1
)
if "%NODE_STATUS%"=="2" (
    echo.
    echo  [提示] 当前 Node.js 低于 22.5，未内置 SQLite，服务将使用降级存储（journal）。
    echo         数据不会丢失，但建议升级到 Node.js 22.5+ 以启用 SQLite 权威存储。
    echo.
)

rem 3) 启动服务（数据目录：server\data，默认只监听 127.0.0.1）
cd /d "%ROOT%\server"
echo  正在启动大聪明本地服务……（关闭本窗口即停止服务；停止不会删除任何聊天或记忆数据）
echo.
"%NODE_EXE%" src\index.js %*
set "EXIT_CODE=%errorlevel%"
if not "%EXIT_CODE%"=="0" (
    echo.
    echo  [需要处理] 服务已退出（代码 %EXIT_CODE%）。常见原因与修复：
    echo    - 端口被占用：服务会自动尝试后续端口；也可用  启动大聪明.cmd --port 8790
    echo    - 数据库迁移失败：服务会进入修复模式，按窗口提示“重试迁移”或“从备份恢复”
    echo    - 权限不足：请不要把本目录放在需要管理员权限的位置
    echo.
)
pause
endlocal
