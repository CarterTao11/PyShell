# PyShell

轻量级 Windows SSH 客户端，基于 Web 技术构建。

## 功能特性

- **SSH 终端** — 通过浏览器访问远程服务器，支持 xterm.js 增强终端体验
- **Tab 分屏** — 多个终端左右 / 上下分屏同时显示，点击窗格切换焦点
- **会话管理** — 保存和管理 SSH 连接，支持分组和标签
- **多种认证** — 支持密码、私钥、键盘交互三种认证方式
- **终端** — 多标签页 + 左右/上下分屏；**全局命令模式**：一条命令回车即发送到所有打开的终端（含历史记录与 ^C 中断）
- **SFTP 文件管理** — 浏览、上传（支持多选、整个文件夹、拖拽，自动保留目录结构，同名文件直接覆盖）、下载、删除、在线编辑文本文件（≤ 2 MB，UTF-8，Ctrl+S 保存直接覆盖）
- **凭据加密** — Windows 下使用 DPAPI 加密存储凭据
- **主机密钥管理** — 首次连接时验证并保存主机密钥指纹

## 快速开始

### 方式一：直接运行

```bash
# 安装依赖
pip install -r requirements.txt

# 启动 (Windows)
python backend/app.py
```

启动后会自动在默认浏览器中打开 PyShell 界面。

### 方式二：Docker

```bash
docker-compose up -d
```

访问 http://localhost:8080

## 项目结构

```
pyshell/
├── backend/          # Python 后端
│   ├── app.py        # Flask 主应用
│   ├── config.py     # 配置
│   ├── models.py     # 数据模型
│   ├── api.py        # API 路由
│   ├── ssh_client.py # SSH 客户端
│   ├── terminal_manager.py # 终端管理
│   ├── sftp_handler.py     # SFTP 操作
│   ├── credential_store.py # 凭据加密存储
│   └── known_hosts.py      # 主机密钥管理
├── web/              # 前端文件
│   ├── index.html
│   ├── css/style.css
│   ├── js/
│   │   ├── app.js
│   │   ├── terminal.js
│   │   ├── session.js
│   │   └── sftp.js
│   └── vendor/       # xterm.js 本地依赖 (无需外网 CDN)
├── tests/
│   ├── test_e2e.py         # 端到端测试 (内置 mock SSH + SFTP server)
│   └── test_split_logic.js # 分屏逻辑冒烟测试 (node tests/test_split_logic.js)
├── requirements.txt
├── Dockerfile
└── docker-compose.yml
```

## 技术栈

- **后端**: Python, Flask, paramiko, SQLAlchemy
- **前端**: xterm.js, HTML/CSS/JS (无框架)
- **数据库**: SQLite
- **加密**: Windows DPAPI / base64 (fallback)

## API 接口

| 方法   | 路径                        | 说明           |
|--------|-----------------------------|----------------|
| GET    | /api/sessions               | 会话列表       |
| POST   | /api/sessions               | 新建会话       |
| PUT    | /api/sessions/:id           | 更新会话       |
| DELETE | /api/sessions/:id           | 删除会话       |
| POST   | /api/ssh/connect            | SSH 连接       |
| POST   | /api/ssh/input/:conn_id     | 发送输入       |
| POST   | /api/ssh/resize             | 调整终端大小   |
| POST   | /api/ssh/disconnect         | 断开连接       |
| GET    | /api/ssh/output/:conn_id    | SSE 终端输出   |
| GET    | /api/sftp/list/:conn_id     | 列出目录       |
| POST   | /api/sftp/upload/:conn_id   | 上传文件       |
| GET    | /api/sftp/download/:conn_id | 下载文件       |
| POST   | /api/sftp/delete/:conn_id   | 删除文件       |
| POST   | /api/sftp/mkdir/:conn_id    | 创建目录       |
| GET    | /api/known-hosts            | 主机密钥列表   |
| POST   | /api/known-hosts            | 接受主机密钥   |
| DELETE | /api/known-hosts/:id        | 删除主机密钥   |
| GET    | /api/credentials            | 凭据列表       |
| DELETE | /api/credentials/:id        | 删除凭据       |
| GET    | /api/status                 | 系统状态       |
| GET    | /api/settings               | 获取设置       |
| PUT    | /api/settings               | 更新设置       |

## 注意

- 凭据加密在 Windows 下使用 DPAPI (用户级加密)，其他平台降级为 base64 编码
- 数据库文件存储在 `data/pyshell.db`
- 默认监听 `127.0.0.1`，仅本地访问