![dashboard]([https://example.com](https://raw.githubusercontent.com/losywee/azure-doh-function/refs/heads/main/dashboard.png)) 
=======
# Azure Functions DoH

基于 Azure Functions Node.js 20、TypeScript 和 programming model v4 的 DNS over HTTPS 服务，内置 React + Tailwind CSS 管理面板。

## 功能

- RFC 8484 `GET` / `POST` DNS over HTTPS
- 多个 DoH 上游轮询和故障转移
- 本地系统 DNS 查询
- DoH 失败后自动回退到本地 DNS
- 自定义 hosts 覆盖
- 基于 `Ad-set-hosts` 的广告域名拦截
- 同一个 Azure Function App 内托管 Dashboard

## HTTP API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/api/dns-query?dns=<base64url>` | RFC 8484 GET 查询 |
| `POST` | `/api/dns-query` | 请求体为 `application/dns-message` |
| `GET` | `/api/dashboard` | 管理面板 |
| `GET` | `/api/config` | 读取运行时配置 |
| `PUT` | `/api/config` | 更新运行时配置 |

配置 API 需要请求头：

```text
x-dashboard-key: <DASHBOARD_KEY>
```

DoH 响应类型为 `application/dns-message`。

## 配置

在 Azure Function App 的 **Configuration > Application settings** 中设置以下变量：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `DASHBOARD_KEY` | 无 | Dashboard 和配置 API 的访问密钥 |
| `DNS_QUERY_MODE` | `doh` | `doh`、`local` 或 `auto` |
| `DOH_UPSTREAM_URLS` | Cloudflare DoH | DoH URL，使用逗号或换行分隔 |
| `DOH_UPSTREAM_URL` | 无 | 单上游兼容配置 |
| `CUSTOM_HOSTS` | 空 | 自定义 hosts 内容 |
| `DOH_TIMEOUT_MS` | `5000` | DoH 超时，最大 `30000` |
| `DOH_MAX_BODY_BYTES` | `65535` | DNS 报文大小，最大 `1048576` |
| `AD_BLOCK_ENABLED` | `false` | 是否启用广告拦截 |
| `AD_BLOCK_SOURCE` | Ad-set-hosts | 广告 hosts 文件 URL |
| `AD_BLOCK_REFRESH_MS` | `21600000` | 广告列表刷新间隔，6 小时 |

### 查询模式

- `doh`：只使用配置的 DoH 上游
- `local`：使用 Azure Functions 运行环境的系统 DNS，仅支持 A 和 AAAA
- `auto`：先使用 DoH，上游全部失败后回退到本地 DNS

### 多个 DoH 上游

```text
DOH_UPSTREAM_URLS=https://cloudflare-dns.com/dns-query,https://dns.google/dns-query
```

每次请求从不同上游开始，并在失败时尝试其余上游。上游必须使用 HTTPS。

### 自定义 hosts

每行格式为 `IP hostname...`，也支持逗号分隔：

```text
10.0.0.10 internal.example.com
2001:db8::10 api.example.com
```

自定义 hosts 的优先级高于 DoH、本地 DNS 和广告列表。

### 广告拦截

默认广告列表来源：

```text
https://raw.githubusercontent.com/rentianyu/Ad-set-hosts/master/hosts
```

启用后，服务按刷新间隔下载标准 hosts 文件并缓存在当前 worker 内存中。命中的域名返回 `NXDOMAIN`，不会转发到上游。拉取失败时继续使用上一次成功的缓存。

该第三方仓库当前未声明开源许可证，请在生产使用前确认其使用条件。

## 本地运行

依赖：

- Node.js 20+
- Azure Functions Core Tools

```bash
npm install
npm install --prefix dashboard
npm run build:all
npm test
npm start
```

本地 Dashboard 地址：

```text
http://localhost:7071/api/dashboard
```

本地配置示例见 `local.settings.json`。该文件已加入 `.gitignore`，不要提交真实密钥。

## Azure 部署

先配置应用设置：

```bash
az functionapp config appsettings set \
  --name <FUNCTION_APP_NAME> \
  --resource-group <RESOURCE_GROUP> \
  --settings \
    DASHBOARD_KEY=<LONG_RANDOM_SECRET> \
    DNS_QUERY_MODE=auto \
    DOH_UPSTREAM_URLS=https://cloudflare-dns.com/dns-query,https://dns.google/dns-query \
    AD_BLOCK_ENABLED=true
```

构建并发布：

```bash
npm run build:all
func azure functionapp publish <FUNCTION_APP_NAME>
```

部署后访问：

```text
https://<FUNCTION_APP_NAME>.azurewebsites.net/api/dashboard
```

Dashboard 修改的是当前 Function worker 的运行时配置。Function 重启、扩容或缩容后，配置会恢复为 Application settings 中的值。需要持久化的配置应同步写入 Azure Application settings。

## 安全建议

- 使用长度足够的随机 `DASHBOARD_KEY`
- 在 Azure Function App 中启用 HTTPS-only
- 为生产环境配置访问限制、API Management 或其他认证层
- 不要公开运行没有访问限制的匿名 DNS 转发器
- 不要在日志中记录 DNS 请求内容
>>>>>>> df135d7 (first commit)
