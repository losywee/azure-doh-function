![dashboard](https://raw.githubusercontent.com/losywee/azure-doh-function/refs/heads/main/dashboard.png)

# Azure Functions DoH

DNS-over-HTTPS relay for Azure Functions, with multiple upstream resolvers, local DNS fallback, custom hosts, ad blocking, and a built-in dashboard.

Azure Functions DNS over HTTPS (DoH) 转发服务，支持多个上游解析器、本地 DNS 回退、自定义 hosts、广告拦截和内置管理面板。

## Features / 功能

- RFC 8484 DoH requests over `GET` and `POST` / 支持 RFC 8484 `GET` 和 `POST` DoH 请求
- Multiple HTTPS upstreams with failover / 多个 HTTPS 上游及故障转移
- `doh`, `local`, and `auto` resolution modes / `doh`、`local` 和 `auto` 解析模式
- Custom hosts overrides / 自定义 hosts 覆盖
- Optional hosts-file ad blocking / 可选 hosts 文件广告拦截
- Built-in React dashboard / 内置 React 管理面板

## Routes / 路由

| Method | Route | Description / 说明 |
| --- | --- | --- |
| `GET` | `/api/dns-query?dns=<base64url>` | DoH DNS query / DoH DNS 查询 |
| `POST` | `/api/dns-query` | DoH request body with `application/dns-message` / 使用 `application/dns-message` 请求体 |
| `GET` | `/api/dashboard` | Dashboard / 管理面板 |
| `GET` | `/api/config` | Read runtime configuration / 读取运行时配置 |
| `PUT` | `/api/config` | Update runtime configuration / 更新运行时配置 |

`/api/admin/*` is reserved by Azure Functions. Use `/api/config`, not `/api/admin/config`.

`/api/admin/*` 是 Azure Functions 保留路径。请使用 `/api/config`，不要使用 `/api/admin/config`。

The configuration routes require this request header:

配置路由必须包含以下请求头：

```text
x-dashboard-key: <DASHBOARD_KEY>
```

## Configuration / 配置

Configure these application settings in Azure Portal under **Function App > Configuration > Application settings**.

在 Azure 门户的 **Function App > Configuration > Application settings** 中设置以下应用设置。

| Setting | Default | Description / 说明 |
| --- | --- | --- |
| `DASHBOARD_KEY` | None / 无 | Dashboard and config API key / 管理面板和配置 API 密钥 |
| `DNS_QUERY_MODE` | `doh` | `doh`, `local`, or `auto` / `doh`、`local` 或 `auto` |
| `DOH_UPSTREAM_URLS` | Cloudflare DoH | Comma- or newline-separated HTTPS URLs / 逗号或换行分隔的 HTTPS URL |
| `DOH_UPSTREAM_URL` | None / 无 | Single-upstream compatibility setting / 单上游兼容设置 |
| `CUSTOM_HOSTS` | Empty / 空 | Hosts entries / hosts 条目 |
| `DOH_TIMEOUT_MS` | `5000` | Upstream timeout, maximum `30000` / 上游超时，最大 `30000` |
| `DOH_MAX_BODY_BYTES` | `65535` | DNS packet limit, maximum `1048576` / DNS 报文限制，最大 `1048576` |
| `AD_BLOCK_ENABLED` | `false` | Enable ad blocking / 启用广告拦截 |
| `AD_BLOCK_SOURCE` | Ad-set-hosts URL | HTTPS hosts file URL / HTTPS hosts 文件 URL |
| `AD_BLOCK_REFRESH_MS` | `21600000` | Blocklist refresh interval / 拦截列表刷新间隔 |

Example upstream configuration / 上游配置示例:

```text
DOH_UPSTREAM_URLS=https://cloudflare-dns.com/dns-query,https://dns.google/dns-query
```

Example custom hosts configuration / 自定义 hosts 示例:

```text
10.0.0.10 internal.example.com
2001:db8::10 api.example.com
```

`doh` uses encrypted upstreams only. `local` uses the Function worker DNS resolver. `auto` tries DoH first, then local DNS.

`doh` 仅使用加密上游。`local` 使用 Function worker 的 DNS 解析器。`auto` 先尝试 DoH，再回退到本地 DNS。

## Local Development / 本地开发

Requirements / 依赖:

- Node.js 20+
- Azure Functions Core Tools

```bash
npm install
npm install --prefix dashboard
npm test
npm start
```

Open the dashboard at `http://localhost:7071/api/dashboard`.

管理面板地址：`http://localhost:7071/api/dashboard`。

Use `local.settings.json` for local application settings. Do not commit real secrets.

使用 `local.settings.json` 保存本地应用设置。不要提交真实密钥。

## Deployment / 部署

Set the required application settings, build, then publish:

设置所需应用设置，构建并发布：

```bash
az functionapp config appsettings set \
  --name <FUNCTION_APP_NAME> \
  --resource-group <RESOURCE_GROUP> \
  --settings \
    DASHBOARD_KEY=<LONG_RANDOM_SECRET> \
    DNS_QUERY_MODE=auto \
    DOH_UPSTREAM_URLS=https://cloudflare-dns.com/dns-query,https://dns.google/dns-query

npm run build:all
func azure functionapp publish <FUNCTION_APP_NAME>
```

After deployment, open:

部署后访问：

```text
https://<FUNCTION_APP_NAME>.azurewebsites.net/api/dashboard
```

Configuration changes made through `/api/config` only affect the current Function worker. They are lost after a restart, scale event, or redeployment. Persist production settings in Azure Application settings.

通过 `/api/config` 的配置修改只影响当前 Function worker。在重启、扩缩容或重新部署后会丢失。生产配置应保存在 Azure Application settings 中。

## Security / 安全

- Use a long, random `DASHBOARD_KEY` / 使用足够长的随机 `DASHBOARD_KEY`
- Enable HTTPS-only / 启用仅 HTTPS
- Restrict production access with networking rules, API Management, or another authentication layer / 使用网络规则、API Management 或其他认证层限制生产访问
- Do not expose an unrestricted anonymous DNS relay / 不要公开无限制的匿名 DNS 转发器
