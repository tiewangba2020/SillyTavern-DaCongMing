@echo off
chcp 65001 >nul
setlocal EnableExtensions EnableDelayedExpansion
title 大聪明 · 从 SillyTavern 卸载

echo.
echo  本脚本只删除「扩展」与「服务端插件」目录，**不会**删除任何记忆数据。
echo  记忆数据在各 SillyTavern 用户目录下的 dacongming 子目录里，需要清理时请自行备份后删除。
echo.

set "ST_DIR=%~1"
if not defined ST_DIR (
    set /p "ST_DIR=请输入 SillyTavern 根目录（包含 server.js 的目录）： "
)
if not exist "!ST_DIR!\server.js" (
    echo  [需要处理] 在 "!ST_DIR!" 下没有找到 server.js。
    pause
    exit /b 1
)

set "EXT_TARGET=!ST_DIR!\public\scripts\extensions\third-party\dacongming"
set "PLUGIN_TARGET=!ST_DIR!\plugins\dacongming"
set "BRIDGE_TARGET=!ST_DIR!\plugins\dacongming-memory"

for %%D in ("!EXT_TARGET!" "!PLUGIN_TARGET!" "!BRIDGE_TARGET!") do (
    if exist "%%~fD" (
        echo  删除 %%~fD
        rd /s /q "%%~fD"
        if exist "%%~fD" (
            echo  [需要处理] 删除失败，可能被 SillyTavern 占用，请先关闭 ST 再重试。
        ) else (
            echo        已删除。
        )
    ) else (
        echo  跳过（不存在）：%%~fD
    )
)

echo.
echo  卸载完成，重启 SillyTavern 生效。
echo  如需一并清理记忆数据，请删除各 SillyTavern 用户目录下的 dacongming 子目录。
echo.
pause
endlocal
