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

    async browse(connId, path) {
        this.currentConnId = connId;
        const target = this.normalizePath(path || '/');

        document.querySelector('.sftp-empty').style.display = 'none';
        document.getElementById('sftp-browser').style.display = 'flex';
        this._syncPathInput(target);

        try {
            const res = await fetch(`/api/sftp/list/${connId}?path=${encodeURIComponent(target)}`);
            const result = await res.json();

            if (!result.success) {
                showToast('SFTP 错误: ' + result.error, 'error');
                // 目录切换失败：保持显示上一个有效目录
                this._syncPathInput();
                return;
            }

            // 只有成功才提交新路径，避免状态与列表不一致
            this.currentPath = target;
            this._renderFiles(result.items);
            this._syncPathInput();
        } catch (err) {
            console.error('SFTP browse error:', err);
            this._syncPathInput();
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

        const status = document.getElementById('sftp-status');

        // 统一为 {relPath, file}：File 对象取 webkitRelativePath（文件夹
        // 选择时非空），拖拽遍历得到的是 {relPath, file} 包装对象
        const entries = Array.from(files).map(f =>
            (f && f.file && typeof f.relPath === 'string')
                ? { relPath: f.relPath, file: f.file }
                : { relPath: (f.webkitRelativePath || f.name), file: f });

        const { planned, dirs } = this._planUploads(this.currentPath, entries);

        // 先递归创建所有目标目录（mkdir -p，已存在的目录直接复用）
        let di = 0;
        for (const d of dirs) {
            if (status) status.textContent = `准备目录 (${++di}/${dirs.size}): ${d}`;
            try {
                const res = await fetch(`/api/sftp/mkdir/${connId}`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ path: d, recursive: true }),
                });
                const r = await res.json();
                if (!r.success) {
                    showToast(`创建目录失败: ${d} — ${r.error || '未知错误'}`, 'error');
                    if (status) status.textContent = '';
                    return;
                }
            } catch (err) {
                showToast('创建目录错误: ' + err.message, 'error');
                if (status) status.textContent = '';
                return;
            }
        }

        // 上传文件（同名文件直接覆盖）
        let ok = 0;
        try {
            for (let j = 0; j < planned.length; j++) {
                const e = planned[j];
                if (status) {
                    status.textContent = `上传中 ${j + 1}/${planned.length}: ${e.relPath}`;
                }
                const formData = new FormData();
                formData.append('file', e.file);
                formData.append('path', e.targetDir);

                const res = await fetch(`/api/sftp/upload/${connId}`, {
                    method: 'POST',
                    body: formData,
                });
                const result = await res.json();
                if (!result.success) {
                    showToast(`上传失败: ${e.relPath} — ${result.error || '未知错误'}`, 'error');
                    break;
                }
                ok++;
            }
            if (status) {
                status.textContent = ok > 0 ? `已上传/覆盖 ${ok} 个文件` : '';
                if (ok > 0) {
                    showToast(`已上传 ${ok} 个文件`, 'success');
                    setTimeout(() => { status.textContent = ''; }, 3000);
                }
            }
        } catch (err) {
            showToast('上传错误: ' + err.message, 'error');
            if (status) status.textContent = '';
        } finally {
            this.browse(connId, this.currentPath);
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
            ta.value = result.content;
            status.textContent =
                `${this._formatSize(result.size)} · UTF-8 · 保存时直接覆盖原文件`;
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
            status.textContent = `已保存 ${new Date().toLocaleTimeString()}（覆盖原文件）`;
            showToast('文件已保存', 'success');
            // 刷新列表以更新修改时间
            if (this.currentConnId) this.browse(this.currentConnId, this.currentPath);
        } catch (err) {
            status.textContent = '';
            showToast('保存错误: ' + err.message, 'error');
        }
    },

    closeEditor() {
        if (this._editorDirty && !confirm('有未保存的修改，确定关闭？')) return;
        document.getElementById('editor-overlay').classList.add('hidden');
        this._editingPath = null;
        this._editorDirty = false;
    },

    async newFile(parentPath) {
        const fileName = prompt('文件名:', 'newfile.txt');
        if (!fileName) return;
        const fullPath = (parentPath.endsWith('/') ? parentPath : parentPath + '/') + fileName;
        try {
            const res = await fetch('/api/sftp/touch/' + this.currentConnId, {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({path: fullPath}),
            });
            const result = await res.json();
            if (!result.success) {
                showToast('创建文件失败: ' + result.error, 'error');
                return;
            }
            // Check if browse dir is the parent
            if (this.currentPath && fullPath.startsWith(this.currentPath)) {
                this.browse(this.currentConnId, this.currentPath);
            }
            showToast('文件已创建', 'success');
        } catch (e) {
            showToast('创建文件失败: ' + e.message, 'error');
        }
    },

    async newFolder(parentPath) {
        const folderName = prompt('文件夹名:', 'newfolder');
        if (!folderName) return;
        const fullPath = (parentPath.endsWith('/') ? parentPath : parentPath + '/') + folderName;
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
                this.browse(this.currentConnId, this.currentPath);
            }
            showToast('文件夹已创建', 'success');
        } catch (e) {
            showToast('创建文件夹失败: ' + e.message, 'error');
        }
    },

    async mkdir(connId) {
        const name = prompt('输入新目录名称:');
        if (!name) return;

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
                this.browse(connId, this.currentPath);
                showToast('目录已创建', 'success');
            } else {
                showToast('创建目录失败: ' + result.error, 'error');
            }
        } catch (err) {
            showToast('创建目录错误: ' + err.message, 'error');
        }
    },

    async deleteFile(path, isDir) {
        if (!confirm(`确定删除 ${isDir ? '目录' : '文件'} "${path}" 吗？`)) return;

        try {
            const res = await fetch(`/api/sftp/delete/${this.currentConnId}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ path, is_dir: isDir }),
            });
            const result = await res.json();
            if (result.success) {
                this.browse(this.currentConnId, this.currentPath);
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