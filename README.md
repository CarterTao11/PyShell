# PyShell

轻量级 Windows SSH 客户端，基于 Web 技术构建。

## 功能特性

- **SSH 终端** — 通过浏览器访问远程服务器，支持 xterm.js 增强终端体验
- **Tab 分屏** — 多个终端左右 / 上下分屏同时显示，点击窗格切换焦点
- **会话管理** — 保存和管理 SSH 连接，支持分组和标签
- **多种认证** — 支持密码、私钥、键盘交互三种认证方式
- **终端** — 多标签页 + 左右/上下分屏；**全局命令模式**：一条命令回车即发送到所有打开的终端（含历史记录与 ^C 中断）
- **命令队列** — 多行命令按顺序执行，通过终端缓冲区完成标记（POSIX shell）自动衔接上一条与下一条
- **定时任务** — 后端线程定时连接已保存会话执行命令（间隔 / 每天两种调度，超时保护，结果与退出码入库），浏览器关闭不影响运行
- **SFTP 文件管理** — 浏览（与终端当前目录联动，终端里 `cd` 时面板跟随）、新建目录/新建空文件（同名文件不覆盖）、上传（支持多选、整个文件夹、拖拽，自动保留目录结构，同名文件直接覆盖；带真实字节进度条，可中途取消）、**目录差异对比**（本地文件夹 vs 远端目录，先比大小/时间，只传有变化的文件并列出远端多出来的旧文件）、下载、删除、在线编辑文本文件（≤ 2 MB，UTF-8，带行号与光标行列显示，Ctrl+S 保存直接覆盖）
- **终端内搜索** — `Ctrl/Cmd+F` 在终端输出里查找（大小写不敏感、↑/↓ 或 Enter / Shift+Enter 循环跳转、`3/12` 计数、Esc 收起）。搜的是 xterm 的缓冲区而不是页面文本，所以回滚区里的历史输出也能搜到
- **命令模板** — 收藏命令里写 `{{变量}}`，执行时逐个弹框填值（默认值沿用上次填的值），取消任一个即整条不发
- **会话状态灯** — 会话列表按 `已连接 / 正在连接… / 连接失败·已断开 / 未连接` 四态显示（绿点 / 琥珀呼吸 / 红灯 / 无点），远端掉线也会亮红灯而不是静默变灰
- **分屏** — 左右/上下分屏；切换标签时新终端进入"焦点窗格"，另一窗格保持稳定不被顶掉

## 打包为 exe

```powershell
# 单文件版（推荐分发）：dist\PyShell.exe，双击即启动并自动打开浏览器
.\.venv\Scripts\pyinstaller --noconfirm --clean --onefile --console --name PyShell --add-data "web;web" --paths backend backend\app.py
pyinstaller  -i .\pyshell.ico --noconfirm --clean --onefile --windowed --name PyShell --add-data "web;web" --add-data "pyshell.ico;." --paths backend backend\app.py

# 目录版（启动更快）：dist\PyShell\PyShell.exe + _internal\
.\.venv\Scripts\pyinstaller --noconfirm --clean --onedir --console --name PyShell --add-data "web;web" --paths backend backend\app.py
```

- 数据（数据库、会话、主机密钥）保存在 **exe 旁边的 `data\` 目录**
- 默认端口 5173，被占用时自动顺延；`PORT` 环境变量可指定
- 前端资源（web/）已打包进 exe，无需随行分发
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
│   │   ├── dialog.js   # 统一弹框（不使用浏览器原生 alert/confirm/prompt）
│   │   ├── template.js # 命令模板（{{变量}} 的提取与替换）
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

- 前端弹框一律用自绘的 `Dialog`（`web/js/dialog.js`），不使用浏览器原生 `alert` / `confirm` / `prompt`：原生弹框会阻塞主线程、样式无法定制、在部分环境里标题带站点名
- 上传进度用 XHR 的 `xhr.upload.onprogress`（`fetch` 拿不到上传进度事件，只能从 0 直接跳到 100）。进度条按**整批文件的总字节**算，多文件时文字标"整体 xx%"；HTTP 请求体发完到服务器返回之间会显示"写入远端…"斜纹态，因为此时 Flask 可能还在 `putfo` 落盘，100% 不等于已落盘
- 取消上传会 `abort()` 当前 XHR，并尽力调 `/api/sftp/delete` 删掉远端写了一半的文件（同名文件已被覆盖，留下半截比删掉更糟）。如果服务器其实已经写完只是响应没回来，这一步会把刚上传的文件删掉——这是取消语义的取舍
- 上传期间两个上传按钮会禁用，同一时刻只跑一批（只有一个进度条，并发会互相覆盖）
- **目录差异对比是单向镜像（本地 → 远端）**，不做双向同步：判定口径只有"大小 + mtime（容差 ±2 秒）"，不算 md5 —— 后端没有 hash 接口，逐文件算摘要意味着每个文件都要先传一遍内容，比整批重传还慢。因此"大小和时间都相同"的文件会被跳过，即使内容其实不同（这种场景请用"上传文件夹"整批覆盖）
- 对比结果里**远端多出来的旧文件只列出、不删除**；选择整个本地文件夹后，它在远端对应的目标是 `当前目录/<文件夹名>`（和"上传文件夹"的语义一致，即保留这一层目录）
- 对比需要递归列出远端目录，条目超过 2 万项会直接报错退出（逐层调 `/api/sftp/list`，大目录会明显变慢）
- 命令模板只做 `{{变量}}` 的纯文本替换：变量名可用中文，不允许空格和花括号；值里如果有空格或引号，需要自己带上引号（如 `--path '{{目录}}'` 填 `/opt/my app`）
- **终端输出有上限，会丢字节**：`docker logs -f` 这类持续大量输出的命令（几十 MB/s）如果原样全量送进浏览器，xterm 的写队列没有上限，标签页会把内存吃干净后直接退出。现在链路两端都设了上界——
  - 后端：未读输出缓冲上限 8MB（`TerminalSession.MAX_OUTPUT_BUFFER`），超了**丢最旧的、保留最新的**，并累计 `dropped_bytes`；
  - SSE：一次事件最多拼 4 块（约 512KB），空闲时心跳降到 10 秒一次，避免几千个事件/秒压垮主线程；后端丢过字节时会补发一个 `event: overflow`，带上丢弃字节数；
  - 前端：一条有界队列（上限 4MB，`OUTPUT_HIGH_WATER`），一次只 `term.write` 一块、等 xterm 解析回调再写下一块（这是对 xterm 唯一的背压手段），超水位同样丢最旧的；
  - 丢弃不会被"吞掉"：累计到 1MB 就在终端里打印一行黄色提示 `[输出过快，浏览器来不及渲染，已丢弃约 X MB 未显示]`，并先做一次 `\x1b[0m` 复位，防止被切断的转义序列把整屏染色。
  - 也就是说，盯着尾部日志看没问题；**如果你需要完整日志，请用 `docker logs ... > file` 落盘再看**，不要在终端里跑无限量的流。
- 凭据加密在 Windows 下使用 DPAPI (用户级加密)，其他平台降级为 base64 编码
- 数据库文件存储在 `data/pyshell.db`
- 默认监听 `127.0.0.1`，仅本地访问