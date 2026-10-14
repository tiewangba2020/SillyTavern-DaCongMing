# 大聪明 · SillyTavern 服务端桥接插件

让手机 / 局域网上的 SillyTavern 页面也能使用大聪明：浏览器请求经 **SillyTavern 服务端**同源代理到本机 `127.0.0.1` 的记忆服务。服务凭证只保存在服务器磁盘，由 SillyTavern 自身的鉴权保护，浏览器不接触凭证。

## 安装

1. 把本目录复制到 `SillyTavern/plugins/dacongming-memory/`（`安装到SillyTavern.cmd` 第 2 步会自动完成）。
2. 在 SillyTavern 的 `config.yaml` 中设置 `enableServerPlugins: true`，重启 SillyTavern。
3. （可选）编辑同目录 `config.json`：

```json
{
  "serviceUrl": "http://127.0.0.1:8787",
  "credentialPath": "E:/工具软件开发中/酒馆插件/大聪明/server/data/credential.json"
}
```

未配置时使用默认端口并自动探测 8787~8799，凭证路径默认按相对目录推断。

## 接口

- `GET /api/plugins/dacongming-memory/health` —— 服务存活与版本。
- `ANY /api/plugins/dacongming-memory/proxy/<服务路径>` —— 透明代理（自动附加凭证）。

扩展会自动探测桥接是否可用，可用时优先走桥接。

## 安全说明

- 只代理到 loopback 地址，不会把请求转发到外网。
- SillyTavern 自身的用户鉴权（basic auth / 多用户）同样保护这些路径；请勿在无鉴权的公网 SillyTavern 上启用。
- 凭证文件 `credential.json` 不应被复制到浏览器或分享。
