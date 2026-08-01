## 部署步骤

### 第 1 步：创建 KV 命名空间

1. 登录 [Cloudflare Dashboard](https://dash.cloudflare.com/)
2. 进入 Workers & Pages → KV
3. 点击「创建命名空间」，名称填 `KEYVAULT_KV`
4. 记下生成的 Namespace ID

### 第 2 步：创建 Pages 项目

#### 方式 A：GitHub 仓库（推荐）

1. Fork 仓库
2. 登录 Cloudflare Dashboard → Workers & Pages → 创建
3. 选择「连接到 Git」→ 选你的仓库
4. 构建设置：
   - 构建命令：留空
   - 构建输出目录：`public`
5. 部署

### 第 3 步：绑定 KV

1. 在 Cloudflare Dashboard → 你的 Pages 项目 → Settings → Bindings
2. 添加绑定：
   - 变量名：`KEYVAULT_KV`
   - 类型：KV 命名空间
   - 选择第 1 步创建的命名空间
3. 重新部署项目

### 第 4 步：使用

1. 打开你的 Pages 网址（如 `https://keyvault.pages.dev`）
2. 设置主密码创建保险库
3. 在设置中填入 API 地址（就是你的 Pages 网址）
4. 在设置中配置 WebDAV 备份

## 配置文件说明

### wrangler.toml

```toml
name = "keyvault"
pages_build_output_dir = "./public"
compatibility_date = "2026-08-01"

[[kv_namespaces]]
binding = "KEYVAULT_KV"
id = "你的 KV Namespace ID"
```

### _routes.json

```json
{
  "version": 1,
  "include": ["/api/*"],
  "exclude": []
}
```

这确保只有 `/api/*` 路径触发 Function，其他路径直接返回静态文件。

### package.json

```json
{
  "name": "keyvault",
  "version": "1.0.0",
  "private": true
}
```

## 三端同步策略

| 存储 | 角色 | 写入时机 | 读取时机 |
|------|------|---------|---------|
| **IndexedDB** | 主工作区（本地缓存） | 每次操作实时写入 | 每次打开应用 |
| **KV 云端** | 云端主存储 | 保存操作后自动推送 | 打开应用时自动拉取 |
| **WebDAV** | 异地备份 | 保存操作后自动备份 | 手动拉取恢复 |

### 同步流程

1. **打开应用** → 从 IndexedDB 读取 → 从 KV 拉取最新 → LWW 合并
2. **保存操作** → 写 IndexedDB → 推送 KV → 备份 WebDAV
3. **手动全量同步** → 同时从 KV + WebDAV 拉取 → LWW 合并 → 推送所有源

### 冲突解决：LWW + Version

- 每个 vault 有单调递增的 `version` 号
- 拉取时比较 version，取更高版本
- version 相同时按 `updatedAt` 时间戳判断
- 每次写入前保存快照到 KV（保留最近 5 个）

## 免费额度评估

| 服务 | 免费额度 | 密码管理器用量 | 余量 |
|------|---------|--------------|------|
| Pages 静态托管 | 无限 | ~100 次/天 | 充足 |
| Pages Functions | 10 万次/天 | ~10 次/天 | 充足 |
| KV 读取 | 10 万次/天 | ~5 次/天 | 充足 |
| KV 写入(同键) | 1 次/秒 | ~2 次/天 | 充足 |
| KV 存储 | 1 GB | ~100 KB | 充足 |

**结论：个人使用完全免费，额度消耗 < 0.01%。**

## 坚果云 WebDAV 配置

1. 登录坚果云 → 右上角头像 → 安全选项 → 第三方应用管理
2. 添加应用密码，名称填 "KeyVault"
3. 在 KeyVault 设置 → WebDAV 填写：
   - 服务器：`https://dav.jianguoyun.com/dav/`
   - 用户名：坚果云邮箱
   - 密码：上一步生成的**应用专用密码**
   - 路径：`/KeyVault/`

**无需单独配置 CORS 代理！** WebDAV 请求走同域的 `/api/webdav-proxy`。

## 安全说明

| 项目 | 说明 |
|------|------|
| 加密 | AES-256-GCM，PBKDF2 60万次迭代 |
| 认证 | 主密码派生 API Token，服务端只存哈希 |
| 存储 | KV 存的是加密密文，服务端无法解密 |
| 零知识 | 前端加密、后端只转发密文 |
| Token | 不持久化，每次从主密码实时派生 |
| 设备盐 | 每台设备独立随机盐存 IndexedDB，防彩虹表 |
| WebDAV 代理 | 域名白名单 + 每IP速率限制（60次/分钟） |
| 离线模式 | 断网自动锁定为只读，顶部显示状态栏 |
| 备份提醒 | 首次解锁有数据时弹窗提醒配置同步 |

## 设备随机盐说明

- **为什么需要设备盐？** 原来所有用户共享硬编码盐值，攻击者可以用通用彩虹表批量破解。改为每台设备独立生成 32 字节随机盐后，每台设备的盐都不同，彩虹表失效。
- **盐存在哪？** 存在浏览器 IndexedDB 的 `config` store 中，key 为 `deviceSalt`。
- **换设备怎么办？** 加密导出文件（`.enc`）会包含盐信息，导入时自动恢复。跨设备迁移步骤：
  1. 在旧设备导出加密备份文件（设置 → 导出加密备份）
  2. 在新设备打开 KeyVault，输入**相同主密码**创建保险库
  3. 导入加密备份文件
  4. 注意：新设备的盐与旧设备不同，导入后旧设备的加密备份将无法在新设备解密，需重新导出

## WebDAV 代理白名单

`/api/webdav-proxy` 只允许代理白名单中的域名，防止被滥用扫描内网/公网。默认白名单：

| 域名 | 服务 |
|------|------|
| `dav.jianguoyun.com` | 坚果云 |
| `webdav.pcloud.com` | pCloud |
| `webdav.hidrive.strato.com` | HiDrive |
| `dav.infini-cloud.net` | InfiniCLOUD |
| `nextcloud` | Nextcloud（含子域名匹配） |
| `cloudflare` | Cloudflare WebDAV |
| `alist` | Alist |

**如需添加自定义 WebDAV 服务器**，修改 `worker.js` 中的 `ALLOWED_WEBDAV_DOMAINS` 数组，添加你的域名即可。

代理还强制 HTTPS，拒绝明文 HTTP 请求（防止 WebDAV 密码被截获），并对每 IP 限制 60 次/分钟请求。

> AI生成
