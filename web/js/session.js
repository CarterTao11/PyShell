/**
 * Session Management (session.js)
 * Handles CRUD operations for SSH sessions.
 */

const SessionManager = {
    sessions: [],

    async load() {
        try {
            const res = await fetch('/api/sessions');
            this.sessions = await res.json();
            this.render();
        } catch (err) {
            console.error('Failed to load sessions:', err);
        }
    },

    async create(data) {
        const res = await fetch('/api/sessions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data),
        });
        const session = await res.json();
        this.sessions.push(session);
        this.render();
        return session;
    },

    async update(id, data) {
        const res = await fetch(`/api/sessions/${id}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data),
        });
        const session = await res.json();
        const idx = this.sessions.findIndex(s => s.id === id);
        if (idx >= 0) this.sessions[idx] = session;
        this.render();
        return session;
    },

    async delete(id) {
        await fetch(`/api/sessions/${id}`, { method: 'DELETE' });
        this.sessions = this.sessions.filter(s => s.id !== id);
        this.render();
    },

    getById(id) {
        return this.sessions.find(s => s.id === id);
    },

    render() {
        const container = document.getElementById('session-list');
        if (!container) return;

        if (this.sessions.length === 0) {
            container.innerHTML = '<div class="loading" style="padding:40px;text-align:center;color:var(--text-secondary);">暂无会话，点击 "+ 新建" 创建</div>';
            return;
        }

        // Group sessions
        const groups = {};
        this.sessions.forEach(s => {
            const g = s.group_name || '默认分组';
            if (!groups[g]) groups[g] = [];
            groups[g].push(s);
        });

        let html = '';
        for (const [group, items] of Object.entries(groups)) {
            html += `<div class="session-group-label">${group}</div>`;
            items.forEach(s => {
                const isConnected = TerminalManager.connectedSessions.has(s.id);
                html += `
                    <div class="session-item${isConnected ? ' connected' : ''}" data-session-id="${s.id}">
                        <div class="session-item-name">${this._escapeHtml(s.name || s.host)}</div>
                        <div class="session-item-host">${s.username}@${s.host}:${s.port}</div>
                        <div class="session-item-info">${s.auth_type}${s.tags && s.tags.length ? ' | ' + s.tags.join(', ') : ''}</div>
                        <div class="session-item-actions">
                            <button class="btn btn-xs btn-connect" data-id="${s.id}" title="连接">▶</button>
                            <button class="btn btn-xs btn-edit" data-id="${s.id}" title="编辑">✎</button>
                            <button class="btn btn-xs btn-danger btn-delete" data-id="${s.id}" title="删除">×</button>
                        </div>
                    </div>
                `;
            });
        }

        container.innerHTML = html;

        // Bind events
        container.querySelectorAll('.session-item').forEach(el => {
            el.addEventListener('dblclick', () => {
                const id = parseInt(el.dataset.sessionId);
                this.connect(id);
            });
        });

        container.querySelectorAll('.btn-connect').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.connect(parseInt(btn.dataset.id));
            });
        });

        container.querySelectorAll('.btn-edit').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.openEditDialog(parseInt(btn.dataset.id));
            });
        });

        container.querySelectorAll('.btn-delete').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.confirmDelete(parseInt(btn.dataset.id));
            });
        });
    },

    _escapeHtml(str) {
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    },

    async connect(sessionId) {
        const session = this.getById(sessionId);
        if (!session) return;

        // 键盘交互模式：弹出密码输入框
        if (session.auth_type === 'keyboard-interactive') {
            const password = await this._promptPassword(session.host, session.username);
            if (!password) return; // 用户取消
            session.password = password;
        }

        // 密码和密钥模式：从数据库获取凭证（后端自动处理）
        const data = {
            session_id: sessionId,
            name: session.name || session.host,
            host: session.host,
            port: session.port,
            username: session.username,
            auth_type: session.auth_type,
            password: session.password,
            private_key: session.private_key,
            passphrase: session.passphrase,
        };

        await TerminalManager.connect(sessionId, data);
        this.render();
    },

    async openNewDialog() {
        this._resetForm();
        document.getElementById('dialog-title').textContent = '新建会话';
        document.getElementById('session-dialog').dataset.mode = 'create';
        document.getElementById('dialog-overlay').classList.remove('hidden');
    },

    async openEditDialog(sessionId) {
        const s = this.getById(sessionId);
        if (!s) return;

        document.getElementById('dialog-title').textContent = '编辑会话';
        document.getElementById('session-dialog').dataset.mode = 'edit';
        document.getElementById('session-dialog').dataset.sessionId = sessionId;

        document.getElementById('form-name').value = s.name || '';
        document.getElementById('form-host').value = s.host || '';
        document.getElementById('form-port').value = s.port || 22;
        document.getElementById('form-username').value = s.username || 'root';
        document.getElementById('form-auth-type').value = s.auth_type || 'password';
        document.getElementById('form-group').value = s.group_name || '';
        document.getElementById('form-tags').value = (s.tags || []).join(', ');
        document.getElementById('form-remark').value = s.remark || '';
        document.getElementById('form-password').value = '';
        document.getElementById('form-private-key').value = '';
        document.getElementById('form-passphrase').value = '';

        this._toggleAuthFields(s.auth_type || 'password');
        document.getElementById('dialog-overlay').classList.remove('hidden');
    },

    confirmDelete(sessionId) {
        const s = this.getById(sessionId);
        if (!s) return;

        document.getElementById('confirm-title').textContent = '删除会话';
        document.getElementById('confirm-message').textContent = `确定要删除会话 "${s.name || s.host}" 吗？`;
        document.getElementById('confirm-overlay').dataset.sessionId = sessionId;
        document.getElementById('confirm-overlay').classList.remove('hidden');
    },

    _resetForm() {
        document.getElementById('form-name').value = '';
        document.getElementById('form-host').value = '';
        document.getElementById('form-port').value = '22';
        document.getElementById('form-username').value = 'root';
        document.getElementById('form-auth-type').value = 'password';
        document.getElementById('form-group').value = '';
        document.getElementById('form-tags').value = '';
        document.getElementById('form-remark').value = '';
        document.getElementById('form-password').value = '';
        document.getElementById('form-private-key').value = '';
        document.getElementById('form-passphrase').value = '';
        this._toggleAuthFields('password');
    },

    _toggleAuthFields(authType) {
        document.getElementById('form-password-group').style.display = (authType === 'password' || authType === 'keyboard-interactive') ? '' : 'none';
        document.getElementById('form-key-group').style.display = (authType === 'key') ? '' : 'none';
        document.getElementById('form-passphrase-group').style.display = (authType === 'key') ? '' : 'none';
    },

    async saveFromForm() {
        const mode = document.getElementById('session-dialog').dataset.mode;
        const sessionId = document.getElementById('session-dialog').dataset.sessionId;

        const data = {
            name: document.getElementById('form-name').value,
            host: document.getElementById('form-host').value,
            port: parseInt(document.getElementById('form-port').value) || 22,
            username: document.getElementById('form-username').value,
            auth_type: document.getElementById('form-auth-type').value,
            group_name: document.getElementById('form-group').value,
            tags: document.getElementById('form-tags').value.split(',').map(t => t.trim()).filter(t => t),
            remark: document.getElementById('form-remark').value,
            password: document.getElementById('form-password').value,
            private_key: document.getElementById('form-private-key').value,
            passphrase: document.getElementById('form-passphrase').value,
        };

        if (!data.host) {
            alert('请输入主机地址');
            return;
        }

        if (mode === 'create') {
            await this.create(data);
        } else {
            await this.update(parseInt(sessionId), data);
        }

        document.getElementById('dialog-overlay').classList.add('hidden');
    },

    // 弹出密码输入框（键盘交互模式）
    _promptPassword(host, username) {
        return new Promise((resolve) => {
            // 创建临时弹框
            const overlay = document.createElement('div');
            overlay.className = 'dialog-overlay';
            overlay.style.cssText = 'display:flex;align-items:center;justify-content:center;z-index:10000';

            overlay.innerHTML = `
                <div class="dialog" style="width:360px">
                    <div class="dialog-header">
                        <h3>键盘交互认证</h3>
                    </div>
                    <div class="dialog-body">
                        <p style="margin-bottom:12px;color:var(--text-secondary)">
                            连接到 <strong>${host}</strong> (${username})<br>
                            请输入密码：
                        </p>
                        <input type="password" id="kbd-password-input"
                               placeholder="密码"
                               style="width:100%;padding:10px;font-size:14px;border:1px solid var(--border);border-radius:4px;background:var(--bg-primary);color:var(--text-primary)">
                    </div>
                    <div class="dialog-footer">
                        <button id="kbd-connect-btn" class="btn btn-primary">连接</button>
                        <button id="kbd-cancel-btn" class="btn">取消</button>
                    </div>
                </div>
            `;

            document.body.appendChild(overlay);

            const input = overlay.querySelector('#kbd-password-input');
            const connectBtn = overlay.querySelector('#kbd-connect-btn');
            const cancelBtn = overlay.querySelector('#kbd-cancel-btn');

            // 回车连接
            input.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    resolve(input.value);
                    overlay.remove();
                } else if (e.key === 'Escape') {
                    resolve(null);
                    overlay.remove();
                }
            });

            connectBtn.addEventListener('click', () => {
                resolve(input.value);
                overlay.remove();
            });

            cancelBtn.addEventListener('click', () => {
                resolve(null);
                overlay.remove();
            });

            // 点击遮罩取消
            overlay.addEventListener('click', (e) => {
                if (e.target === overlay) {
                    resolve(null);
                    overlay.remove();
                }
            });

            // 自动聚焦输入框
            setTimeout(() => input.focus(), 100);
        });
    }
};