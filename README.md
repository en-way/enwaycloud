# ☁️ CF R2 Drive — 基于 Cloudflare Pages + R2 的轻量级网页云盘

一个完全运行在 Cloudflare 免费套餐上的个人网页云盘，无需服务器，无需数据库。

## ✨ 功能特性

- 📂 **目录浏览** — 面包屑导航，多级文件夹支持
- 📤 **拖拽上传** — 支持多文件并行上传，大文件（≥ 5MB）自动使用 R2 Multipart 分块上传
- 👁️ **在线预览** — 图片 / 视频 / 音频 / 文本 / 代码 / PDF 一键预览（Modal 弹窗）
- ⬇️ **文件下载** — 支持强制下载，中文文件名正确编码
- 🗑️ **删除操作** — 二次确认删除文件或空文件夹
- 📁 **新建文件夹** — 在当前目录创建子文件夹
- 🔐 **密码鉴权** — 单密码保护，`localStorage` 缓存，支持 `?auth=` 媒体直链
- 📋 **列表 / 网格** 双视图切换，支持按名称 / 大小 / 时间排序
- 📱 **响应式设计** — 移动端和桌面端自适应布局
- 🚫 **零外部依赖** — 纯原生 HTML / CSS / JS，无任何 npm 包或 CDN

---

## 📁 目录结构

```text
.
├── public/                 # 前端静态资源（Cloudflare Pages 托管目录）
│   ├── index.html          # 页面主体结构
│   ├── style.css           # 纯原生 CSS 样式表
│   └── app.js              # 前端核心交互逻辑
├── functions/              # Cloudflare Pages Functions（后端 API）
│   └── api/
│       ├── _middleware.js  # 全局 API 鉴权中间件
│       ├── files.js        # 文件列表查询 GET /api/files
│       └── file.js         # 文件 CRUD + 分块上传 /api/file
├── wrangler.toml           # Cloudflare 本地开发与绑定配置
└── README.md               # 本文档
```

---

## 🚀 快速开始（本地开发）

### 前置条件

- Node.js 18+
- 一个 Cloudflare 账号（免费即可）
- 在 Cloudflare 控制台已创建 R2 存储桶

### 1. 安装 Wrangler CLI

```bash
npm install -g wrangler
```

### 2. 登录 Cloudflare

```bash
wrangler login
```

浏览器会弹出授权页面，确认后自动完成登录。

### 3. 修改 `wrangler.toml`

打开 `wrangler.toml`，将 `your-bucket-name` 替换为你在 Cloudflare 控制台创建的 R2 存储桶名称：

```toml
[[r2_buckets]]
binding = "R2_BUCKET"
bucket_name = "my-drive-bucket"          # ← 改为你的存储桶名
preview_bucket_name = "my-drive-bucket"  # ← 同上
```

如需本地测试密码功能，在 `[vars]` 下临时添加（**不要提交到 Git**）：

```toml
[vars]
DRIVE_PASSWORD = "my-secret-password"
```

### 4. 启动本地开发服务器

```bash
npx wrangler pages dev . --r2=R2_BUCKET
```

> **说明**：`--r2=R2_BUCKET` 参数将本地开发环境绑定到真实的 R2 存储桶（会实际读写！）。  
> 若不想影响生产数据，可先在 Cloudflare 控制台创建一个单独的开发用存储桶。

### 5. 访问应用

浏览器打开：[http://localhost:8788](http://localhost:8788)

---

## ☁️ 部署到 Cloudflare Pages

### 第一步：创建 Cloudflare Pages 项目

**方式 A：通过 Git 仓库连接（推荐）**

1. 将代码推送到 GitHub / GitLab 仓库
2. 登录 [Cloudflare Dashboard](https://dash.cloudflare.com) → **Workers & Pages** → **Create application** → **Pages** → **Connect to Git**
3. 选择你的仓库，配置构建设置：
   - **Framework preset**：`None`
   - **Build command**：（留空）
   - **Build output directory**：`public`
4. 点击 **Save and Deploy**

**方式 B：直接上传（无需 Git）**

```bash
npx wrangler pages deploy public --project-name cf-r2-drive
```

---

### 第二步：绑定 R2 存储桶

1. 在 Cloudflare Dashboard 中，进入你的 Pages 项目
2. 点击顶部 **Settings** 标签
3. 左侧菜单选择 **Functions**
4. 滚动找到 **R2 bucket bindings** 区域，点击 **Add binding**
5. 填写：
   - **Variable name**：`R2_BUCKET`（必须与代码中一致，区分大小写）
   - **R2 bucket**：选择你的存储桶
6. 分别为 **Production** 和 **Preview** 两个环境都添加绑定
7. 点击 **Save**

---

### 第三步：配置密码环境变量

1. 在 Pages 项目的 **Settings** → **Environment variables**
2. 点击 **Add variable**，填写：
   - **Variable name**：`DRIVE_PASSWORD`
   - **Value**：你的访问密码
   - 勾选 **Encrypt**（加密存储，推荐）
3. 同样为 Production 和 Preview 两个环境配置
4. 点击 **Save**

> **提示**：如果不设置 `DRIVE_PASSWORD`，API 将对所有请求开放，不进行鉴权。

---

### 第四步：触发重新部署

绑定 R2 和配置变量后，需要重新部署才能生效：

- **Git 方式**：提交一个空 commit 触发 CI，或在 Cloudflare Dashboard → Deployments → 点击 **Retry deployment**
- **手动方式**：重新运行 `npx wrangler pages deploy public --project-name cf-r2-drive`

---

## 🔌 API 接口文档

所有接口需携带密码（若已配置 `DRIVE_PASSWORD`）：

| 方式 | 示例 |
|---|---|
| Header | `X-Drive-Password: your-password` |
| Authorization | `Authorization: Bearer your-password` |
| URL 参数（媒体直链用） | `?auth=your-password` |

### GET /api/files

查询目录文件列表。

| 参数 | 类型 | 说明 |
|---|---|---|
| `prefix` | string | 目录前缀，如 `photos/2024/`，默认为空（根目录） |
| `cursor` | string | 分页游标（可选） |
| `limit` | number | 每页最大条数，默认 500，最大 1000 |

**响应示例：**

```json
{
  "prefix": "photos/",
  "folders": ["photos/2024/", "photos/2023/"],
  "files": [
    {
      "key": "photos/cover.jpg",
      "size": 204800,
      "uploaded": "2024-09-01T12:00:00.000Z",
      "httpMetadata": { "contentType": "image/jpeg" }
    }
  ],
  "truncated": false,
  "cursor": null
}
```

### GET /api/file

预览或下载文件。

| 参数 | 类型 | 说明 |
|---|---|---|
| `key` | string | 文件完整路径，如 `photos/cover.jpg` |
| `download` | `1` | 传 `1` 强制触发浏览器下载 |
| `auth` | string | 密码（用于媒体标签直链） |

支持 `Range` 请求（视频流式播放）。

### PUT /api/file

普通上传（适合 < 5MB 文件）。

| 参数 | 类型 | 说明 |
|---|---|---|
| `key` | string | 目标路径，如 `docs/report.pdf` |

请求体为文件二进制流，`Content-Type` 设置为文件 MIME 类型。

### PUT /api/file?action=mkdir

新建文件夹（上传 0 字节占位对象）。

| 参数 | 类型 | 说明 |
|---|---|---|
| `key` | string | 文件夹路径，如 `photos/new-folder/` |

### 分块上传（大文件）

| 步骤 | 方法 | 端点 | 说明 |
|---|---|---|---|
| 1 | POST | `/api/file?key=xxx&action=createMultipart` | 创建上传任务，返回 `uploadId` |
| 2 | PUT | `/api/file?key=xxx&action=uploadPart&uploadId=xxx&partNumber=N` | 上传第 N 块（最小 5MB） |
| 3 | POST | `/api/file?key=xxx&action=completeMultipart` | 完成合并，Body: `{uploadId, parts:[{partNumber,etag}]}` |
| 中止 | DELETE | `/api/file?key=xxx&action=abortMultipart&uploadId=xxx` | 取消并清理 |

### DELETE /api/file

删除文件或空文件夹。

| 参数 | 类型 | 说明 |
|---|---|---|
| `key` | string | 文件路径；文件夹路径需以 `/` 结尾 |

---

## ❓ 常见问题

**Q：上传大文件时浏览器报超时或 524 错误？**  
A：这是 Cloudflare 对 Worker 请求的时间限制（免费计划 CPU 时间 10ms，但 I/O 等待可更长）。分块上传每块 8MB，正常情况下单块上传耗时 < 30 秒，不会超时。如仍出现问题，可尝试减小 `app.js` 中的 `CHUNK_SIZE` 常量（如改为 `5 * 1024 * 1024`）。

**Q：能上传多大的文件？**  
A：R2 对象最大支持 5TB，分块上传最多 10,000 块。使用本项目的 8MB 分块配置，理论最大文件约 **80GB**。

**Q：文件夹显示不出来？**  
A：R2 没有真正的目录概念，本项目通过上传一个以 `/` 结尾的 0 字节对象来模拟文件夹。若文件夹是在 R2 控制台或其他工具中创建的真实前缀（非占位对象），在有文件的情况下也会通过 `delimiter:'/'` 自动显示。

**Q：删除文件夹时提示"不为空"？**  
A：本项目只能删除空文件夹（即只包含占位对象本身的文件夹）。请先手动删除文件夹内的所有文件，再删除文件夹。

**Q：密码忘了怎么办？**  
A：在 Cloudflare Dashboard → Pages → Settings → Environment variables 中重新设置 `DRIVE_PASSWORD`，然后触发重新部署即可。

**Q：如何取消密码保护（公开访问）？**  
A：删除 `DRIVE_PASSWORD` 环境变量（或将其设为空值），重新部署后所有 API 请求将不再需要密码。

**Q：本地开发时如何模拟没有配置密码的状态？**  
A：在 `wrangler.toml` 中不设置 `DRIVE_PASSWORD`（注释掉或删除该行），重启本地服务器即可。

---

## 📄 License

MIT License — 自由使用，欢迎 Star ⭐
