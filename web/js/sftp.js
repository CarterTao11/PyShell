/**
 * SFTP File Browser (sftp.js)
 */

const SFTPManager = {
    currentPath: '/',
    currentConnId: null,

    /** 规范化远程路径：统一斜杠、去多余斜杠、去尾部斜杠（根目录除外） */
    normalizePath(p) {
        if (!p) return '/';
        let s = String(p).trim().replace(/\\/g, '/');
        if (!s) return '/';
        if (!s.startsWith('/')) s = '/' + s;
        s = s.replace(/\/{2,}/g, '/');
        if (s.length > 1) s = s.replace(/\/+$/, '');
        return s || '/';
    },

    /** 父目录：/a/b -> /a, /a -> /, / -> / */
    _parentOf(path) {
        const s = this.normalizePath(path || '/');
        if (s === '/') return '/';
        const idx = s.lastIndexOf('/');
        return idx <= 0 ? '/' : s.slice(0, idx);
    },

    /** 把路径写入输入框（不传值则显示当前目录） */
    _syncPathInput(value) {
        const input = document.getElementById('sftp-path-input');
        if (input) {
            input.value = value !== undefined ? value : (this.currentPath || '/');
        }
    },

    /** 拼接子项路径（currentPath 已规范化，无双斜杠问题） */
    _join(name) {
        return this.currentPath === '/' ? '/' + name : this.currentPath + '/' + name;
    },

    /** 返回上一级目录 */
    goUp() {
        if (!this.currentConnId) {
            showToast('请先连接一个终端', 'warning');
            return;
        }
        const parent = this._parentOf(this.currentPath);
        if (parent === this.currentPath) return;  // 已在根目录
        this.browse(this.currentConnId, parent);
    },

    /** 直接跳转到输入的路径 */
    goTo(path) {
        if (!this.currentConnId) {
            showToast('请先连接一个终端', 'warning');
            return;
        }
        const p = (path || '').trim();
        if (!p) return;
        this.browse(this.currentConnId, p);
    },

    /** 是否已经为某个连接打开过面板（打开过才做后台跟随） */
    _opened: false,
    _browsing: false,
    _pendingBrowse: null,

    _showBrowser() {
        const empty = document.querySelector('.sftp-empty');
        if (empty) empty.style.display = 'none';
        const browser = document.getElementById('sftp-browser');
        if (browser) browser.style.display = 'flex';
    },

    /** 收回空状态（无连接 / 连接已断开） */
    _showEmpty(html) {
        const empty = document.querySelector('.sftp-empty');
        const browser = document.getElementById('sftp-browser');
        if (empty) {
            empty.innerHTML = html || '<p>请先通过 SSH 连接终端，</p><p>然后在此查看文件。</p>';
            empty.style.display = 'block';
        }
        if (browser) browser.style.display = 'none';
        this.currentConnId = null;
        this.currentPath = '/';
        this._opened = false;
        this._pendingBrowse = null;
        this._syncPathInput('/');
    },

    /** 列表区占位文字（切连接/加载中时清掉上一台机器的列表） */
    _setListMessage(text) {
        const container = document.getElementById('sftp-file-list');
        if (container) {
            container.innerHTML = `<div style="padding:20px;text-align:center;color:var(--text-secondary);">${
                this._escapeHtml(text)}</div>`;
        }
    },

    /**
     * 打开 SFTP 面板并进入终端当前目录 —— "选择 SFTP 标签"的唯一入口。
     * 路径来源是终端，所以这里绝不向终端注入 cd（否则每次切标签都会
     * 在终端里多打一条 cd，还会打断正在输入的命令）。
     */
    async openForTerminal(connId) {
        if (!connId) {
            this._showEmpty();
            return false;
        }

        if (this.currentConnId !== connId) {
            // 切到另一台机器的连接：旧列表不能留在界面上
            this.currentPath = '/';
            this._setListMessage('加载中...');
        }

        const cwd = await TerminalManager.getTrackedCwd(connId);
        let ok = await this.browse(connId, cwd, { syncTerminal: false, quiet: true });

        if (!ok) {
            // 跟踪目录可能已被删除或没有权限：退回 home 再试一次
            const home = await TerminalManager.getHomeDir(connId);
            if (this.normalizePath(home) !== this.normalizePath(cwd)) {
                ok = await this.browse(connId, home, { syncTerminal: false, quiet: true });
            }
        }
        if (!ok) {
            this._setListMessage('无法读取该目录，请在上方输入框手动指定路径');
            showToast('无法读取终端当前目录，请在上方输入框手动指定路径', 'warning');
        }
        return ok;
    },

    /**
     * 终端 cd 后由 TerminalManager 调用：SFTP 跟随（面板隐藏时后台刷新，
     * 用户切回 SFTP 标签看到的就是最新目录）。
     *
     * 跟随失败（目录不存在 / 无权限 / 主机限制）时不再静默：面板保留上一
     * 有效目录，同时在状态栏说明原因 —— 否则用户看到的就是"SFTP 不动了"。
     */
    async onTerminalCwd(connId, path) {
        if (!this._opened || this.currentConnId !== connId) return;
        const target = this.normalizePath(path || '/');
        if (target === this.currentPath) {
            this._syncPathInput();
            this._clearStatus();
            return;
        }
        const ok = await this._enqueueBrowse(connId, target,
            { syncTerminal: false, quiet: true });
        if (ok === null) return;      // 已排队，结论由正在跑的那一趟处理
        if (ok) {
            this._clearStatus();
            return;
        }
        // 面板已经切到别的连接 / 被收起时不再提示
        if (this.currentConnId !== connId || !this._opened) return;
        const msg = `终端已切到 ${target}，但 SFTP 无法列出该目录（已保留 ${this.currentPath}）`;
        console.warn('[dir-sync]', msg);
        this._setStatus(msg);
    },

    /** 状态栏（上传进度也用它；只覆盖自己写的内容） */
    _setStatus(text) {
        const status = document.getElementById('sftp-status');
        if (status) status.textContent = text;
        this._ownStatus = text;
    },

    _clearStatus() {
        if (!this._ownStatus) return;
        const status = document.getElementById('sftp-status');
        if (status && status.textContent === this._ownStatus) status.textContent = '';
        this._ownStatus = '';
    },

    /** 连接断开：正在浏览它就把面板收回空状态 */
    onConnectionClosed(connId) {
        if (this.currentConnId !== connId) return;
        this._showEmpty('<p>当前终端已断开，</p><p>请重新连接后再查看文件。</p>');
    },

    /** 串行排队 browse，避免并发请求互相覆盖 currentPath */
    _enqueueBrowse(connId, path, opts) {
        this._pendingBrowse = { connId, path, opts };
        // 不忙时直接跑一趟并把结果回给调用方；忙时排队，由正在跑的那一趟处理，
        // 这里返回 null 表示"已排队，暂无结论"
        if (!this._browsing) return this._flushPendingBrowse();
        return Promise.resolve(null);
    },

    async _flushPendingBrowse() {
        this._browsing = true;
        let last = false;
        try {
            while (this._pendingBrowse) {
                const job = this._pendingBrowse;
                this._pendingBrowse = null;
                last = await this.browse(job.connId, job.path, job.opts || {});
            }
        } catch (e) {
            console.warn('_flushPendingBrowse error:', e);
        } finally {
            this._browsing = false;
        }
        return last;
    },

    /**
     * 列目录。
     * @param {object} [opts]
     * @param {boolean} [opts.syncTerminal=true] 切换成功后是否让终端跟随 cd
     * @param {boolean} [opts.quiet] 失败时不弹 toast
     * @returns {Promise<boolean>} 是否成功
     */
    async browse(connId, path, opts = {}) {
        const syncTerminal = opts.syncTerminal !== false;
        this.currentConnId = connId;
        this._opened = true;

        let target = this.normalizePath(path || '/');
        if (!target.startsWith('/')) target = '/';

        this._showBrowser();
        this._syncPathInput(target);

        try {
            const res = await fetch(`/api/sftp/list/${connId}?path=${encodeURIComponent(target)}`);
            const result = await res.json();

            if (!result.success) {
                // 路径无效：保留上一次有效目录，既不改终端也不跳回根目录
                // （旧实现在这里强制回 / 并把终端也 cd 到 /，非常危险）
                console.warn('SFTP list failed:', target, result.error);
                this._syncPathInput();
                if (!opts.quiet) showToast('SFTP 错误: ' + result.error, 'error');
                return false;
            }

            // 只有成功才提交新路径，避免状态与列表不一致
            this.currentPath = target;
            this._renderFiles(result.items);
            this._syncPathInput();

            // SFTP 里切换目录 -> 终端跟随（路径没变时 applyCwdFromSftp 自行跳过）
            if (syncTerminal && typeof TerminalManager !== 'undefined'
                    && TerminalManager.instances.has(connId)) {
                TerminalManager.applyCwdFromSftp(connId, target);
            }
            return true;
        } catch (err) {
            console.error('SFTP browse error:', err);
            this._syncPathInput();
            if (!opts.quiet) showToast('SFTP 错误: ' + err.message, 'error');
            return false;
        }
    },

    /** HTML 转义：文件名进入 innerHTML 前必须转义（路径损坏 + XSS 防护） */
    _escapeHtml(s) {
        return String(s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    },

    _renderFiles(items) {
        const container = document.getElementById('sftp-file-list');

        if (!items || items.length === 0) {
            container.innerHTML = '<div style="padding:20px;text-align:center;color:var(--text-secondary);">(空目录)</div>';
            return;
        }

        // 排序：文件夹在前，文件在后；组内按名称排序
        // （不区分大小写，数字按自然顺序 file2 < file10；
        //   用 'en' collation 保证英文/数字在前、中文按拼音在后）
        const sorted = [...items].sort((a, b) => {
            if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1;
            return String(a.name).localeCompare(
                String(b.name), 'en', { numeric: true, sensitivity: 'base' });
        });

        let html = '';

        // Parent directory (双击直接回到上级，data-parent 标记避免路径误拼接)
        if (this.currentPath !== '/') {
            html += `
                <div class="sftp-file-item" data-parent="1">
                    <span class="file-icon">📁</span>
                    <span class="file-name">..</span>
                    <span class="file-size"></span>
                    <span class="file-time"></span>
                </div>
            `;
        }

        sorted.forEach(item => {
            const isDir = item.is_dir;
            const icon = isDir ? '📁' : '📄';
            const size = isDir ? '' : this._formatSize(item.size);
            const time = item.mtime ? new Date(item.mtime * 1000).toLocaleString() : '';
            const safeName = this._escapeHtml(item.name);

            html += `
                <div class="sftp-file-item" data-path="${safeName}" data-is-dir="${isDir}" title="${safeName}">
                    <span class="file-icon">${icon}</span>
                    <span class="file-name">${safeName}</span>
                    <span class="file-size">${size}</span>
                    <span class="file-time">${time}</span>
                </div>
            `;
        });

        container.innerHTML = html;

        // Bind events
        container.querySelectorAll('.sftp-file-item').forEach(el => {
            // ".." 行：直接跳到上级
            if (el.dataset.parent) {
                el.addEventListener('dblclick', () => {
                    this.browse(this.currentConnId, this._parentOf(this.currentPath));
                });
                return;
            }

            const isDir = el.dataset.isDir === 'true';
            const name = el.dataset.path;

            if (isDir) {
                el.addEventListener('dblclick', () => {
                    this.browse(this.currentConnId, this._join(name));
                });
            } else {
                el.addEventListener('dblclick', () => {
                    this.download(this._join(name));
                });
            }

            // Right-click context menu
            el.addEventListener('contextmenu', (e) => {
                e.preventDefault();
                this._showContextMenu(e, this._join(name), isDir);
            });
        });
    },

    /**
     * 规划上传：把 {relPath, file} 条目映射到目标目录，并收集需要确保
     * 存在的目录集合（不含 currentPath 本身，mkdir -p 服务端保证幂等）。
     */
    _planUploads(currentPath, entries) {
        const dirs = new Set();
        const planned = entries.map(e => {
            const rel = String(e.relPath || e.file.name).replace(/\\/g, '/');
            const idx = rel.lastIndexOf('/');
            const dirPart = idx >= 0 ? rel.slice(0, idx) : '';
            const targetDir = this.normalizePath(
                currentPath + (dirPart ? '/' + dirPart : ''));
            if (targetDir !== currentPath) dirs.add(targetDir);
            return { relPath: rel, file: e.file, targetDir };
        });
        return { planned, dirs };
    },

    async upload(connId, files) {
        if (!connId) {
            showToast('请先连接一个终端', 'warning');
            return;
        }

        // No files given -> open the file picker (allows multiple selection)
        if (!files) {
            const input = document.createElement('input');
            input.type = 'file';
            input.multiple = true;
            files = await new Promise(resolve => {
                input.onchange = () => resolve(input.files);
                // Picking nothing / closing the dialog fires `cancel`
                // on modern browsers, otherwise the promise would hang.
                input.oncancel = () => resolve(null);
                // Must be called synchronously inside the user gesture
                // handler, or the browser blocks the file dialog.
                input.click();
            });
        }
        if (!files || files.length === 0) return;

        // 统一为 {relPath, file}：File 对象取 webkitRelativePath（文件夹
        // 选择时非空），拖拽遍历得到的是 {relPath, file} 包装对象
        const entries = Array.from(files).map(f =>
            (f && f.file && typeof f.relPath === 'string')
                ? { relPath: f.relPath, file: f.file }
                : { relPath: (f.webkitRelativePath || f.name), file: f });

        const { planned, dirs } = this._planUploads(this.currentPath, entries);

        // 同一时刻只跑一批：进度条只有一个，两批并发会互相覆盖（也会抢同名文件）
        if (this._uploading) {
            showToast('正在上传，请等当前批次结束或点"取消"', 'warning');
            return;
        }
        this._uploading = true;
        this._uploadAbort = false;
        this._uploadXhr = null;
        this._setUploadButtonsEnabled(false);

        const startedAt = Date.now();
        let ok = 0;
        let aborted = false;
        let failed = false;

        try {
            // 阶段一：递归创建目标目录（mkdir -p，已存在直接复用）
            this._progressShow();
            const token = this._progressToken;
            let di = 0;
            for (const d of dirs) {
                if (this._uploadAbort) { aborted = true; break; }
                this._progressSet(`准备目录 ${++di}/${dirs.size} · ${d}`, 0, '准备中…');
                const r = await this._postJSON(`/api/sftp/mkdir/${connId}`, { path: d, recursive: true });
                if (!r.success) {
                    failed = true;
                    showToast(`创建目录失败: ${d} — ${r.error || '未知错误'}`, 'error');
                    break;
                }
            }

            // 阶段二：逐个上传（按总字节算整体进度，进度条不会一个文件就跳满）
            if (!aborted && !failed) {
                const totalBytes = planned.reduce((s, e) => s + (e.file.size || 0), 0);
                let doneBytes = 0;
                const state = { totalBytes, startedAt };

                for (let j = 0; j < planned.length; j++) {
                    if (this._uploadAbort) { aborted = true; break; }
                    const e = planned[j];
                    const size = e.file.size || 0;
                    this._renderProgress({
                        fileIndex: j, totalFiles: planned.length, name: e.relPath,
                        loaded: 0, total: size, doneBytes, totalBytes, startedAt,
                    });
                    const r = await this._uploadOne(connId, e.file, e.targetDir, (loaded, total) => {
                        this._renderProgress({
                            fileIndex: j, totalFiles: planned.length, name: e.relPath,
                            loaded, total: total || size, doneBytes, totalBytes, startedAt,
                        });
                    });
                    if (r.aborted) {
                        aborted = true;
                        // 中止时远端大概率已经留下半个文件：尽力删掉，别让同名文件被截断成半截
                        const remote = (e.targetDir + '/' + e.file.name).replace('//', '/');
                        try {
                            await this._postJSON(`/api/sftp/delete/${connId}`, { path: remote });
                        } catch (err) { /* 清理失败不影响取消流程 */ }
                        break;
                    }
                    if (!r.ok) {
                        failed = true;
                        showToast(`上传失败: ${e.relPath} — ${r.error || '未知错误'}`, 'error');
                        break;
                    }
                    doneBytes += size;
                    ok++;
                }

                if (!aborted && !failed && ok > 0) {
                    this._renderProgress({
                        fileIndex: planned.length - 1, totalFiles: planned.length, name: '',
                        loaded: totalBytes, total: totalBytes,
                        doneBytes: totalBytes, totalBytes, startedAt, finished: true,
                    });
                    showToast(`已上传 ${ok} 个文件`, 'success');
                    // 留 1.2s 让用户看到 100%，再收起
                    setTimeout(() => {
                        if (this._progressToken === token) this._progressHide();
                    }, 1200);
                }
            }
            if (aborted) showToast('上传已取消（已清理远端未完成的文件）', 'warning');
        } catch (err) {
            failed = true;
            showToast('上传错误: ' + err.message, 'error');
        } finally {
            this._uploading = false;
            this._uploadAbort = false;
            this._uploadXhr = null;
            this._setUploadButtonsEnabled(true);
            // 失败留 1.5s 红色条让人看见；取消立刻收；成功那条走上面的定时
            if (failed && planned.length) {
                this._progressMarkError();
                const token2 = this._progressToken;
                setTimeout(() => {
                    if (this._progressToken === token2) this._progressHide();
                }, 1500);
            } else if (aborted) {
                this._progressHide();
            }
            if (planned.length) this.browse(connId, this.currentPath, { syncTerminal: false });
        }
    },

    /** POST JSON，返回解析后的结果（失败时不抛异常，交给调用方判断 success） */
    async _postJSON(url, payload) {
        const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        });
        try {
            return await res.json();
        } catch (e) {
            return { success: false, error: `HTTP ${res.status}` };
        }
    },

    /**
     * 上传单个文件：必须用 XHR —— fetch 拿不到上传进度事件，
     * 大文件用 fetch 时界面会从 0 直接跳到 100%，这就是"进度条不动"的根因。
     */
    _uploadOne(connId, file, dirPath, onProgress) {
        return new Promise(resolve => {
            const xhr = new XMLHttpRequest();
            this._uploadXhr = xhr;
            let settled = false;
            const done = (result) => {
                if (settled) return;
                settled = true;
                if (this._uploadXhr === xhr) this._uploadXhr = null;
                resolve(result);
            };

            xhr.open('POST', `/api/sftp/upload/${connId}`, true);
            if (xhr.upload) {
                xhr.upload.onprogress = (e) => {
                    if (!e.lengthComputable) return;
                    try { onProgress(e.loaded, e.total); } catch (err) { /* 渲染异常不影响传输 */ }
                };
            }
            xhr.onload = () => {
                let result = {};
                try { result = JSON.parse(xhr.responseText || '{}'); } catch (e) { /* 非 JSON */ }
                const httpOk = xhr.status >= 200 && xhr.status < 300;
                done({
                    ok: httpOk && result.success !== false,
                    error: result.error || (httpOk ? '' : `HTTP ${xhr.status}`),
                });
            };
            xhr.onerror = () => done({ ok: false, error: '网络错误' });
            xhr.ontimeout = () => done({ ok: false, error: '请求超时' });
            xhr.onabort = () => done({ ok: false, aborted: true, error: '已取消' });

            const form = new FormData();
            form.append('file', file);
            form.append('path', dirPath);
            xhr.send(form);
        });
    },

    /** 取消当前上传（中止正在传的文件，队列不再继续） */
    cancelUpload() {
        if (!this._uploading) return;
        this._uploadAbort = true;
        const xhr = this._uploadXhr;
        if (xhr) {
            try { xhr.abort(); } catch (e) { /* 已结束 */ }
        }
    },

    _setUploadButtonsEnabled(on) {
        ['btn-sftp-upload', 'btn-sftp-upload-folder'].forEach(id => {
            const btn = document.getElementById(id);
            if (btn) btn.disabled = !on;
        });
    },

    // ---- 进度条渲染 ----

    _progressShow() {
        this._progressToken = (this._progressToken || 0) + 1;
        const box = document.getElementById('sftp-progress');
        if (!box) return;
        box.classList.remove('hidden');
        const bar = document.getElementById('sftp-progress-bar');
        if (bar) bar.classList.remove('is-flushing', 'is-error');
        this._progressSet('', 0, '');
    },

    _progressHide() {
        const box = document.getElementById('sftp-progress');
        if (box) box.classList.add('hidden');
        const bar = document.getElementById('sftp-progress-bar');
        if (bar) {
            bar.style.width = '0%';
            bar.classList.remove('is-flushing', 'is-error');
        }
        const track = document.getElementById('sftp-progress-track');
        if (track) track.setAttribute('aria-valuenow', '0');
    },

    _progressMarkError() {
        const bar = document.getElementById('sftp-progress-bar');
        if (bar) {
            bar.classList.remove('is-flushing');
            bar.classList.add('is-error');
        }
    },

    _progressSet(label, pct, text) {
        const box = document.getElementById('sftp-progress');
        if (!box) return;
        const clamped = Math.max(0, Math.min(100, Number(pct) || 0));
        const labelEl = document.getElementById('sftp-progress-label');
        const textEl = document.getElementById('sftp-progress-text');
        const bar = document.getElementById('sftp-progress-bar');
        const track = document.getElementById('sftp-progress-track');
        if (labelEl) labelEl.textContent = label || '';
        if (textEl) textEl.textContent = text || '';
        if (bar) bar.style.width = clamped + '%';
        if (track) track.setAttribute('aria-valuenow', String(Math.round(clamped)));
    },

    /** 字节数（0 也要有单位，进度文本里不能出现 "0/2.5 MB" 这种空档） */
    _formatBytes(n) {
        const units = ['B', 'KB', 'MB', 'GB', 'TB'];
        let size = Math.abs(Number(n) || 0);
        let i = 0;
        while (size >= 1024 && i < units.length - 1) { size /= 1024; i++; }
        // 512 KB 比 512.0 KB 好读；小于 10 的才保留一位小数
        const digits = i === 0 ? 0 : (size >= 10 ? 0 : 1);
        return size.toFixed(digits) + ' ' + units[i];
    },

    /**
     * 进度条 = 整批文件的总字节进度（单个文件时与文件进度一致）。
     * 文字 = 当前文件字节 + 速度；HTTP 发完到服务器返回之间是"写入远端"阶段。
     */
    _renderProgress(p) {
        const totalBytes = p.totalBytes || 0;
        const loaded = Math.max(0, Math.min(p.loaded || 0, p.total || 0));
        const doneBytes = p.doneBytes || 0;
        let pct;
        if (totalBytes > 0) {
            pct = ((doneBytes + loaded) / totalBytes) * 100;
        } else {
            // 全是 0 字节文件：退化成按文件个数算
            pct = (p.fileIndex / Math.max(1, p.totalFiles)) * 100;
        }

        const flushing = !p.finished && p.total > 0 && loaded >= p.total;
        const elapsed = Math.max(0.3, (Date.now() - (p.startedAt || Date.now())) / 1000);
        const speed = (doneBytes + loaded) / elapsed;

        const label = p.finished
            ? `完成 ${p.totalFiles}/${p.totalFiles}`
            : `${p.fileIndex + 1}/${p.totalFiles} · ${p.name}`;

        // 多文件时进度条是"整批"进度，文字里的百分比也标成整体，避免和单文件字节打架
        const overallTag = p.totalFiles > 1 ? '整体 ' : '';

        let text;
        if (p.finished) {
            text = `100% · ${this._formatBytes(totalBytes)}`;
        } else if (flushing) {
            text = `${overallTag}${pct.toFixed(0)}% · 写入远端…`;
        } else {
            text = `${overallTag}${pct.toFixed(0)}% · ${this._formatBytes(loaded)}/${this._formatBytes(p.total)}`
                + (speed > 0 ? ` · ${this._formatBytes(speed)}/s` : '');
        }

        this._progressSet(label, pct, text);
        const bar = document.getElementById('sftp-progress-bar');
        if (bar) {
            bar.classList.toggle('is-flushing', !!flushing);
            bar.classList.remove('is-error');
        }
    },

    /** 上传整个文件夹（保留内部目录结构，同名文件直接覆盖） */
    async uploadFolder(connId) {
        if (!connId) {
            showToast('请先连接一个终端', 'warning');
            return;
        }
        const input = document.createElement('input');
        input.type = 'file';
        input.webkitdirectory = true;
        const files = await new Promise(resolve => {
            input.onchange = () => resolve(input.files);
            input.oncancel = () => resolve(null);
            input.click();
        });
        if (!files || files.length === 0) return;
        await this.upload(connId, files);
    },

    // ---- 拖拽目录/文件遍历 (DataTransferItem.webkitGetAsEntry) ----

    _entryFile(entry) {
        return new Promise((resolve, reject) => entry.file(resolve, reject));
    },

    /** readEntries 每次最多返回 100 条，必须循环读到空为止 */
    _readAllEntries(reader) {
        return new Promise((resolve, reject) => {
            const all = [];
            const readBatch = () => reader.readEntries(batch => {
                if (batch.length === 0) { resolve(all); return; }
                all.push(...batch);
                readBatch();
            }, reject);
            readBatch();
        });
    },

    async _walkEntry(entry, prefix) {
        if (entry.isFile) {
            const file = await this._entryFile(entry);
            return [{ relPath: prefix + entry.name, file }];
        }
        if (entry.isDirectory) {
            const out = [];
            const children = await this._readAllEntries(entry.createReader());
            for (const child of children) {
                out.push(...await this._walkEntry(child, prefix + entry.name + '/'));
            }
            return out;
        }
        return [];
    },

    /** 把文件拖进文件列表直接上传 */
    _setupDragDrop() {
        const list = document.getElementById('sftp-file-list');
        if (!list || list.dataset.dndBound) return;
        list.dataset.dndBound = '1';

        list.addEventListener('dragover', (e) => {
            e.preventDefault();
            list.classList.add('dragover');
        });
        list.addEventListener('dragleave', () => {
            list.classList.remove('dragover');
        });
        list.addEventListener('drop', (e) => {
            e.preventDefault();
            list.classList.remove('dragover');
            if (!this.currentConnId) {
                showToast('请先连接一个终端', 'warning');
                return;
            }

            // webkitGetAsEntry 必须在事件回调内同步调用（事件返回后失效）
            const fallbackFiles = Array.from(e.dataTransfer.files || []);
            const syncEntries = Array.from(e.dataTransfer.items || [])
                .filter(it => it.kind === 'file' && it.webkitGetAsEntry)
                .map(it => it.webkitGetAsEntry())
                .filter(Boolean);

            (async () => {
                // 递归遍历拖入的文件/文件夹，保留目录结构
                let collected = [];
                for (const en of syncEntries) {
                    try {
                        collected = collected.concat(await this._walkEntry(en, ''));
                    } catch (err) {
                        console.error('walk entry error:', err);
                    }
                }
                if (collected.length === 0) {
                    // 回退：浏览器不支持 entry API 时按普通文件处理
                    collected = fallbackFiles.map(f => ({ relPath: f.name, file: f }));
                }
                if (collected.length > 0) {
                    this.upload(this.currentConnId, collected);
                }
            })();
        });
    },

    async download(filePath) {
        const connId = this.currentConnId;
        if (!connId) return;

        try {
            const res = await fetch(`/api/sftp/download/${connId}?path=${encodeURIComponent(filePath)}`);
            if (!res.ok) {
                const err = await res.json();
                showToast('下载失败: ' + (err.error || ''), 'error');
                return;
            }

            const blob = await res.blob();
            const filename = filePath.split('/').pop();
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = filename;
            a.click();
            URL.revokeObjectURL(url);
        } catch (err) {
            showToast('下载错误: ' + err.message, 'error');
        }
    },

    // ---- 在线文本编辑 ----
    _editingPath: null,
    _editorDirty: false,
    _editorSizeText: '',
    _editorGutterLines: 0,

    /** 绑定行号槽：滚动同步 + 内容变化重建行号 + 光标位置更新状态栏（只绑一次） */
    _bindEditorGutter() {
        if (this._editorGutterBound) return;
        const ta = document.getElementById('editor-textarea');
        const gutter = document.getElementById('editor-gutter');
        if (!ta || !gutter) return;
        this._editorGutterBound = true;

        ta.addEventListener('scroll', () => { gutter.scrollTop = ta.scrollTop; });
        ta.addEventListener('input', () => {
            this._editorRenderGutter();
            this._editorUpdateStatus();
        });
        ['click', 'keyup', 'select'].forEach(ev => {
            ta.addEventListener(ev, () => this._editorUpdateStatus());
        });
    },

    /**
     * 重建行号槽。行数不变时只同步滚动位置，避免每敲一个字都重建整块文本。
     * @param {boolean} [force] 打开新文件时强制重建
     */
    _editorRenderGutter(force) {
        const ta = document.getElementById('editor-textarea');
        const gutter = document.getElementById('editor-gutter');
        if (!ta || !gutter) return;
        const count = String(ta.value).split('\n').length;
        if (!force && count === this._editorGutterLines) {
            gutter.scrollTop = ta.scrollTop;
            return;
        }
        this._editorGutterLines = count;
        const numbers = [];
        for (let i = 1; i <= count; i++) numbers.push(i);
        // 末尾不留换行，否则 white-space:pre 会多渲染一行空行
        gutter.textContent = numbers.join('\n');
        // 位数变化时槽宽自动加宽，默认留出两位（"1" 与 "100" 不跳动）
        gutter.style.minWidth = (String(count).length + 1) + 'ch';
        gutter.scrollTop = ta.scrollTop;
    },

    /** 状态栏：第几行 / 共几行 + 文件大小 + 编码 */
    _editorUpdateStatus(prefix) {
        const ta = document.getElementById('editor-textarea');
        const status = document.getElementById('editor-status');
        if (!ta || !status) return;
        const value = String(ta.value);
        const total = value.split('\n').length;
        const pos = value.slice(0, ta.selectionStart || 0).split('\n').length;
        const parts = [];
        if (prefix) parts.push(prefix);
        parts.push(`第 ${pos} 行 / 共 ${total} 行`);
        if (this._editorSizeText) parts.push(this._editorSizeText);
        parts.push('UTF-8');
        status.textContent = parts.join(' · ');
    },

    async editFile(path) {
        if (!this.currentConnId) {
            showToast('请先连接一个终端', 'warning');
            return;
        }
        const overlay = document.getElementById('editor-overlay');
        const ta = document.getElementById('editor-textarea');
        const status = document.getElementById('editor-status');
        document.getElementById('editor-title').textContent = '编辑文件 — ' + path;

        overlay.classList.remove('hidden');
        ta.value = '';
        status.textContent = '加载中...';
        try {
            // POST + JSON body：避免 query string 的编码问题（+、%、特殊字符）
            const res = await fetch(`/api/sftp/read/${this.currentConnId}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ path }),
            });
            const result = await res.json();
            if (!result.success) {
                overlay.classList.add('hidden');
                showToast(`无法打开文件: ${result.error}`, 'error');
                return;
            }
            this._editingPath = path;
            this._editorDirty = false;
            this._editorSizeText = this._formatSize(result.size);
            ta.value = result.content;
            ta.scrollTop = 0;
            this._bindEditorGutter();
            this._editorRenderGutter(true);   // 行号：打开即按实际行数铺满
            this._editorUpdateStatus();
        } catch (err) {
            overlay.classList.add('hidden');
            showToast('读取文件错误: ' + err.message, 'error');
        }
    },

    async saveEditor() {
        if (!this._editingPath || !this.currentConnId) return;
        const ta = document.getElementById('editor-textarea');
        const status = document.getElementById('editor-status');
        status.textContent = '保存中...';
        try {
            const res = await fetch(`/api/sftp/write/${this.currentConnId}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ path: this._editingPath, content: ta.value }),
            });
            const result = await res.json();
            if (!result.success) {
                status.textContent = '';
                showToast('保存失败: ' + result.error, 'error');
                return;
            }
            this._editorDirty = false;
            this._editorUpdateStatus('已保存 ' + new Date().toLocaleTimeString());
            showToast('文件已保存', 'success');
            // 刷新列表以更新修改时间
            if (this.currentConnId) this.browse(this.currentConnId, this.currentPath, { syncTerminal: false });
        } catch (err) {
            status.textContent = '';
            showToast('保存错误: ' + err.message, 'error');
        }
    },

    async closeEditor() {
        if (this._editorDirty) {
            const ok = await Dialog.confirm('有未保存的修改，确定关闭？', {
                title: '关闭编辑器', message: '未保存的修改将会丢失。',
                okText: '放弃修改', cancelText: '继续编辑', danger: true,
            });
            if (!ok) return;
        }
        document.getElementById('editor-overlay').classList.add('hidden');
        this._editingPath = null;
        this._editorDirty = false;
    },

    /**
     * 新建文件。工具栏"+ 新建文件"与右键菜单共用这一个实现。
     * @param {string} [parentPath] 建在哪个目录下，默认当前目录
     * @param {string} [connId] 连接 id，默认当前连接
     */
    async newFile(parentPath, connId) {
        const conn = connId || this.currentConnId;
        const base = this.normalizePath(parentPath || this.currentPath || '/');
        if (!conn) {
            showToast('请先连接一个终端', 'warning');
            return;
        }
        const input = await Dialog.prompt({
            title: '新建文件',
            message: base,
            label: '文件名（可含子目录，如 logs/app.log）',
            value: 'newfile.txt',
            okText: '创建',
        });
        if (input === null) return;                       // 取消
        const name = String(input).trim().replace(/^\/+/, '');
        if (!name) {
            showToast('文件名不能为空', 'warning');
            return;
        }
        // 逐段校验：拒绝 . / ..（否则会指向父目录或造出怪文件）+ 拒绝控制字符
        const segments = name.split('/').filter(s => s !== '');
        if (!segments.length || segments.some(s => s === '.' || s === '..' || /[\x00-\x1f]/.test(s))) {
            showToast('文件名无效（不能是 . / .. 或包含控制字符）', 'warning');
            return;
        }
        const fullPath = this.normalizePath(base + '/' + segments.join('/'));
        // 防止误删/误覆盖：目标必须是 base 下的文件，而不是目录本身
        if (fullPath === base) {
            showToast('文件名无效', 'warning');
            return;
        }

        try {
            const res = await fetch('/api/sftp/touch/' + conn, {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                // exclusive: 同名文件直接报错，不截断已有内容
                body: JSON.stringify({path: fullPath, exclusive: true}),
            });
            const result = await res.json();
            if (!result.success) {
                showToast('创建文件失败: ' + result.error, 'error');
                return;
            }
            if (this.currentConnId === conn) {
                this.browse(conn, this.currentPath, { syncTerminal: false });
            }
            showToast('文件已创建: ' + fullPath, 'success');
        } catch (e) {
            showToast('创建文件失败: ' + e.message, 'error');
        }
    },

    /** 工具栏入口：在当前目录新建文件 */
    async createFile(connId) {
        return this.newFile(this.currentPath, connId);
    },

    async newFolder(parentPath) {
        const folderName = await Dialog.prompt({
            title: '新建文件夹',
            message: parentPath,
            label: '文件夹名',
            value: 'newfolder',
            okText: '创建',
        });
        if (folderName === null) return;
        const name = folderName.trim();
        if (!name) {
            showToast('文件夹名不能为空', 'warning');
            return;
        }
        const fullPath = (parentPath.endsWith('/') ? parentPath : parentPath + '/') + name;
        try {
            const res = await fetch('/api/sftp/mkdir/' + this.currentConnId, {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({path: fullPath}),
            });
            const result = await res.json();
            if (!result.success) {
                showToast('创建文件夹失败: ' + result.error, 'error');
                return;
            }
            if (this.currentPath && fullPath.startsWith(this.currentPath)) {
                this.browse(this.currentConnId, this.currentPath, { syncTerminal: false });
            }
            showToast('文件夹已创建', 'success');
        } catch (e) {
            showToast('创建文件夹失败: ' + e.message, 'error');
        }
    },

    async mkdir(connId) {
        const raw = await Dialog.prompt({
            title: '新建目录',
            message: this.currentPath || '/',
            label: '目录名称（支持多级，如 docs/images）',
            value: '',
            okText: '创建',
        });
        if (raw === null) return;
        const name = raw.trim();
        if (!name) {
            showToast('目录名称不能为空', 'warning');
            return;
        }

        // recursive: true —— 允许一次输入多级路径（如 docs/images），父目录自动补建
        const target = this.normalizePath(this.currentPath + '/' + name);

        try {
            const res = await fetch(`/api/sftp/mkdir/${connId}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ path: target, recursive: true }),
            });
            const result = await res.json();
            if (result.success) {
                this.browse(connId, this.currentPath, { syncTerminal: false });
                showToast('目录已创建', 'success');
            } else {
                showToast('创建目录失败: ' + result.error, 'error');
            }
        } catch (err) {
            showToast('创建目录错误: ' + err.message, 'error');
        }
    },

    async deleteFile(path, isDir) {
        const ok = await Dialog.confirm(`确定删除${isDir ? '目录' : '文件'} "${path}" 吗？`, {
            title: isDir ? '删除目录' : '删除文件',
            message: isDir ? '目录及其全部内容都会被删除，且不可恢复。' : '文件删除后不可恢复。',
            okText: '删除', cancelText: '取消', danger: true,
        });
        if (!ok) return;

        try {
            const res = await fetch(`/api/sftp/delete/${this.currentConnId}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ path, is_dir: isDir }),
            });
            const result = await res.json();
            if (result.success) {
                this.browse(this.currentConnId, this.currentPath, { syncTerminal: false });
                showToast(isDir ? '目录已删除' : '文件已删除', 'success');
            } else {
                showToast('删除失败: ' + result.error, 'error');
            }
        } catch (err) {
            showToast('删除错误: ' + err.message, 'error');
        }
    },

    _formatSize(bytes) {
        if (!bytes || bytes === 0) return '';
        const units = ['B', 'KB', 'MB', 'GB', 'TB'];
        let i = 0;
        let size = bytes;
        while (size >= 1024 && i < units.length - 1) {
            size /= 1024;
            i++;
        }
        return size.toFixed(i === 0 ? 0 : 1) + ' ' + units[i];
    },

    _showContextMenu(e, filePath, isDir) {
        // Remove existing context menu
        document.querySelectorAll('.context-menu').forEach(el => el.remove());

        const menu = document.createElement('div');
        menu.className = 'context-menu';
        menu.style.left = e.clientX + 'px';
        menu.style.top = e.clientY + 'px';

        if (isDir) {
            menu.innerHTML = `
                <div class="context-menu-item" data-action="newfile">新建文件</div>
                <div class="context-menu-item" data-action="newfolder">新建文件夹</div>
                <div class="context-menu-divider"></div>
                <div class="context-menu-item" data-action="open">打开</div>
            `;
        } else {
            menu.innerHTML = `
                <div class="context-menu-item" data-action="edit">编辑</div>
                <div class="context-menu-item" data-action="download">下载</div>
                <div class="context-menu-item danger" data-action="delete">删除</div>
            `;
        }

        document.body.appendChild(menu);

        menu.querySelectorAll('.context-menu-item').forEach(item => {
            item.addEventListener('click', () => {
                const action = item.dataset.action;
                if (action === 'newfile') this.newFile(filePath);
                else if (action === 'newfolder') this.newFolder(filePath);
                else if (action === 'edit') this.editFile(filePath);
                else if (action === 'download') this.download(filePath);
                else if (action === 'delete') this.deleteFile(filePath, isDir);
                else if (action === 'open') {
                    const newPath = filePath;
                    this.browse(this.currentConnId, newPath);
                }
                menu.remove();
            });
        });

        // Close on click outside
        setTimeout(() => {
            document.addEventListener('click', () => menu.remove(), { once: true });
        }, 0);
    },
};