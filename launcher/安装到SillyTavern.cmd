@echo off
chcp 65001 >nul
setlocal EnableExtensions EnableDelayedExpansion
title 大聪明 · 安装到 SillyTavern

set "ROOT=%~dp0.."
for %%I in ("%ROOT%") do set "ROOT=%%~fI"

echo.
echo  本脚本会把「浏览器扩展」装到 SillyTavern，并可选安装服务端部分：
echo    [2/3] 内嵌服务端插件 —— 推荐：随 ST 启停，不用开窗口、不用配对、不占端口
echo    [3/3] 同源桥接插件   —— 仅在「手机/局域网访问 + 独立服务」时才需要
echo  不会修改你的聊天、角色卡、预设或世界书。
echo.

set "ST_DIR=%~1"
if not defined ST_DIR (
    set /p "ST_DIR=请输入 SillyTavern 根目录（包含 server.js 的目录）： "
)
if not exist "!ST_DIR!\server.js" (
    echo.
    echo  [需要处理] 在 "!ST_DIR!" 下没有找到 server.js，请确认这是 SillyTavern 根目录。
    pause
    exit /b 1
)

rem ---- 1) 浏览器扩展（全局 third-party）----
set "EXT_TARGET=!ST_DIR!\public\scripts\extensions\third-party\dacongming"
echo  [1/3] 安装扩展到：!EXT_TARGET!
if exist "!EXT_TARGET!" (
    echo        已存在旧版本，将覆盖更新（设置保存在 SillyTavern 用户数据中，不受影响）。
)
robocopy "%ROOT%\extension\dacongming" "!EXT_TARGET!" /E /NFL /NDL /NJH /NJS /NC /NS /NP >nul
if errorlevel 8 (
    echo  [需要处理] 复制扩展失败，请检查目录权限。
    pause
    exit /b 1
)
echo        完成。

rem ---- 2) 内嵌服务端插件（推荐）----
set "INSTALL_PLUGIN=Y"
set /p "INSTALL_PLUGIN=是否安装内嵌服务端插件（推荐：不用窗口、不用配对）？[Y/n] "
if /I not "!INSTALL_PLUGIN!"=="n" (
    set "PLUGIN_TARGET=!ST_DIR!\plugins\dacongming"
    echo  [2/3] 安装内嵌插件到：!PLUGIN_TARGET!
    robocopy "%ROOT%\st-plugin\dacongming" "!PLUGIN_TARGET!" /E /NFL /NDL /NJH /NJS /NC /NS /NP >nul
    if errorlevel 8 (
        echo  [需要处理] 复制插件入口失败。
        pause
        exit /b 1
    )
    robocopy "%ROOT%\server\src" "!PLUGIN_TARGET!\src" /E /NFL /NDL /NJH /NJS /NC /NS /NP >nul
    if errorlevel 8 (
        echo  [需要处理] 复制内核代码失败。
        pause
        exit /b 1
    )
    rem 检查 SillyTavern 是否开启服务端插件
    findstr /R /C:"^[ ]*enableServerPlugins:[ ]*true" "!ST_DIR!\config.yaml" >nul 2>&1
    if errorlevel 1 (
        echo.
        echo  [需要处理] config.yaml 里尚未开启服务端插件，请把下面这行加进去再重启 SillyTavern：
        echo             enableServerPlugins: true
    ) else (
        echo        已确认 config.yaml 中 enableServerPlugins: true
    )
    echo        完成（内核零第三方依赖，随 ST 进程运行）。
) else (
    echo  [2/3] 跳过内嵌插件。
)

rem ---- 3) 可选：同源桥接插件（手机/局域网 + 独立服务）----
set "INSTALL_BRIDGE=N"
set /p "INSTALL_BRIDGE=是否安装同源桥接插件（手机/局域网访问且使用独立服务）？[y/N] "
if /I "!INSTALL_BRIDGE!"=="y" (
    set "BRIDGE_TARGET=!ST_DIR!\plugins\dacongming-memory"
    echo  [3/3] 安装桥接插件到：!BRIDGE_TARGET!
    robocopy "%ROOT%\st-bridge\dacongming-memory" "!BRIDGE_TARGET!" /E /NFL /NDL /NJH /NJS /NC /NS /NP >nul
    if errorlevel 8 (
        echo  [需要处理] 复制桥接插件失败。
        pause
        exit /b 1
    )
    rem 写入凭证路径配置（凭证只在本机磁盘，不进入浏览器）
    set "CRED=%ROOT%\server\data\credential.json"
    set "CRED=!CRED:\=/!"
    > "!BRIDGE_TARGET!\config.json" echo { "serviceUrl": "http://127.0.0.1:8787", "credentialPath": "!CRED!" }
    echo        完成。
) else (
    echo  [3/3] 跳过桥接插件。
)

echo.
echo  安装完成。下一步：
echo    1. 重启 SillyTavern（服务端插件只在启动时加载）；
echo    2. 刷新页面，在“扩展”面板找到“大聪明”；
echo    3. 装了内嵌插件：面板显示“已连接 SillyTavern 内嵌服务”，直接打开“自动管理”即可；
echo       用独立服务：先运行 启动大聪明.cmd，再在面板点“连接服务”完成配对。
echo.
echo  卸载：运行「卸载大聪明.cmd」只删除扩展与插件目录，不动你的记忆数据。
echo.
pause
endlocal
