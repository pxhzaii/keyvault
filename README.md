
# KeyVault — 多源同步密码管理器

AES-256-GCM 加密 | KV 云端 + WebDAV 备份 + IndexedDB 本地存储

## 功能特性

- **AES-256-GCM 加密**：PBKDF2 60万次迭代，确定性派生盐
- **三端同步**：KV 云端（主存储）+ WebDAV（坚果云等异地备份）+ IndexedDB（本地缓存）
- **密码生成器**：可配置长度和字符集
- **访问密码**：通过环境变量 `GATE_PASSWORD` 控制，前端零接触密码
- **暴力破解防护**：指数退避锁定
- **离线模式**：断网时自动切换，禁止写操作



---

## 部署

### 第一步：创建 KV Namespace

1. 登录 [Cloudflare Dashboard](https://dash.cloudflare.com/)
2. 左侧菜单 → **Workers & Pages** → **KV**
3. 点击 **Create a namespace**，名称填 `keyvault-kv`
4. 创建后记录 **Namespace ID**
5. 修改**wrangler.toml**

### 第二步：创建 Pages 项目

1. 左侧菜单 → **Workers & Pages** → **Create** → **Pages** → **Connect to Git**
2. 选择你的 GitHub 仓库
3. 构建设置：
   - **Framework preset**：`None`
   - **Build command**：留空
   - **Build output directory**：`public`
4. 点击 **Save and Deploy**

### 第三步：绑定 KV Namespace

1. 进入项目 → **Settings** → **Functions**
2. **KV namespace bindings** → **Add binding**
   - **Variable name**：`KEYVAULT_KV`（必须一致）
   - **KV namespace**：选择第一步创建的 namespace
3. 点击 **Save**
4. 修改绑定后需**重新部署**才生效：Deployments 页面 → **Retry deployment**

### 第四步：配置环境变量（可选）

项目 **Settings** → **Environment variables**：

| 变量名 | 说明 | 示例 |
|--------|------|------|
| `GATE_PASSWORD` | 访问密码（不设置则关闭门禁） | `mySecret123` |
| `WEBDAV_ALLOWED_DOMAINS` | WebDAV 域名白名单，已弃用 | `dav.jianguoyun.com,nextcloud.example.com` |

### 第五步：验证

1. 打开 Pages 分配的域名
2. 创建主密码 → 添加条目 → 测试推送/恢复

### 自定义域名（可选）

项目 **Settings** → **Custom domains** → **Add**，按提示添加 CNAME 记录。

---

## WebDAV 代理部署（坚果云等场景）

### 为什么需要代理？

坚果云（`dav.jianguoyun.com`）使用 Cloudflare CDN，从 CF Pages 直接请求会遇到 520 错误。需要通过非 CF 网络的代理转发请求。

### Vercel 部署步骤

1. 将 `keyvault-webdav-proxy/` 目录推到独立的 GitHub 仓库
   ```
   keyvault-webdav-proxy/
   ├── api/
   │   └── webdav.js      # 从 webdav.js 移动到 api/ 目录下
   └── package.json
   ```
   > Vercel 要求 Serverless Function 放在 `api/` 目录下，访问路径自动变为 `/api/webdav`

2. 登录 [Vercel](https://vercel.com/) → **Add New** → **Project** → 导入该仓库
3. 直接点击 **Deploy**
4. 记录域名，如 `https://keyvault-webdav-proxy.vercel.app`

### 在 KeyVault 中配置

1. 打开 KeyVault → 设置 → WebDAV 备份
2. 服务器类型选 **坚果云**（自动填充地址和代理）
3. 代理地址填 Vercel 域名：`https://你的项目.vercel.app/api/webdav`
4. 填写坚果云用户名和**应用专用密码**（不是登录密码）
5. 点击 **测试** 验证连接

### 自建 WebDAV 白名单

| 修改位置 | 方法 |
|----------|------|
| CF Pages 环境变量 | 设置 `WEBDAV_ALLOWED_DOMAINS` |
| Vercel 代理 | 修改 `api/webdav.js` 中的 `ALLOWED_DOMAINS` |
| 后端源码 | 修改 `[[route]].js` 中的 `DEFAULT_ALLOWED_DOMAINS` |

---

## 安全说明

- 主密码不存储，丢失无法恢复
- Token 以 SHA-256 哈希存储于 KV，服务端无法反推主密码
- AES-256-GCM 加密所有存储数据
- WebDAV 代理限制目标域名白名单 + 速率限制
- 访问密码由环境变量控制，前端零接触
- 密码字段通过 `_pwMap` 机制避免明文写入 DOM
- 暴力破解防护：指数退避锁定

## 技术栈

- 前端：原生 HTML/CSS/JS，无框架依赖
- 后端：Cloudflare Pages Functions
- 存储：Cloudflare KV + IndexedDB
- 加密：Web Crypto API (PBKDF2 + AES-256-GCM)
 
## License

MIT

> AI生成
