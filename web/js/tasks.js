/**
 * Scheduled Tasks (tasks.js) 定时任务
 * 管理对话框：任务列表 + 新建/编辑表单。任务由后端调度线程执行，
 * 浏览器关闭不影响运行。
 */
const TaskManager = {
    editingId: null,   // null = 新建模式

    async open() {
        document.getElementById('tasks-overlay').classList.remove('hidden');
        await this.refresh();
        await this._loadSessions();
    },

    close() {
        document.getElementById('tasks-overlay').classList.add('hidden');
        this.editingId = null;
    },

    async _api(url, opts) {
        const res = await fetch(url, opts);
        const r = await res.json();
        if (!r.success) throw new Error(r.error || '未知错误');
        return r;
    },

    async refresh() {
        const list = document.getElementById('task-list');
        try {
            const r = await this._api('/api/tasks');
            const tasks = r.tasks || [];
            if (tasks.length === 0) {
                list.innerHTML = '<div class="task-empty">暂无任务，请在下方创建。</div>';
                return;
            }
            list.innerHTML = tasks.map(t => this._renderRow(t)).join('');
            list.querySelectorAll('button[data-act]').forEach(btn => {
                btn.addEventListener('click', () => this._onAction(btn.dataset));
            });
        } catch (e) {
            list.innerHTML = `<div class="task-empty">加载失败: ${e.message}</div>`;
        }
    },

    _scheduleText(t) {
        if (t.schedule_type === 'daily') return `每天 ${t.daily_time}`;
        const s = t.interval_seconds || 0;
        if (s % 3600 === 0) return `每 ${s / 3600} 小时`;
        if (s % 60 === 0) return `每 ${s / 60} 分钟`;
        return `每 ${s} 秒`;
    },

    _statusBadge(t) {
        if (!t.last_run) return '<span class="task-badge idle">未运行</span>';
        if (t.last_status === 'ok') return '<span class="task-badge ok">成功</span>';
        if (t.last_status === 'timeout') return '<span class="task-badge err">超时</span>';
        return `<span class="task-badge err">失败${t.last_exit_code != null ? ' (' + t.last_exit_code + ')' : ''}</span>`;
    },

    _renderRow(t) {
        const esc = s => String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
        const cmd = esc((t.command || '').split('\n')[0]);
        return `
        <div class="task-row">
            <div class="task-main">
                <div class="task-title">
                    <label class="task-switch" title="${t.enabled ? '禁用' : '启用'}">
                        <input type="checkbox" data-toggle-id="${t.id}" ${t.enabled ? 'checked' : ''}>
                    </label>
                    <strong>${esc(t.name || '未命名任务')}</strong>
                    <span class="task-host">${esc(t.host)}</span>
                </div>
                <div class="task-cmd" title="${esc(t.command)}">$ ${cmd}</div>
                <div class="task-meta">
                    <span>${this._scheduleText(t)}</span>
                    <span>超时 ${t.timeout_seconds}s</span>
                    <span>最近: ${t.last_run || '—'}</span>
                    ${this._statusBadge(t)}
                </div>
                ${t.last_output ? `<details class="task-out"><summary>输出</summary><pre>${esc(t.last_output)}</pre></details>` : ''}
            </div>
            <div class="task-ops">
                <button class="btn btn-xs" data-act="run" data-id="${t.id}">立即执行</button>
                <button class="btn btn-xs" data-act="edit" data-id="${t.id}">编辑</button>
                <button class="btn btn-xs danger" data-act="del" data-id="${t.id}">删除</button>
            </div>
        </div>`;
    },

    async _onAction(ds) {
        const id = parseInt(ds.id, 10);
        try {
            if (ds.act === 'run') {
                this._flashRow(id, '执行中…');
                const r = await this._api(`/api/tasks/${id}/run`, { method: 'POST' });
                const res = r.result || {};
                const st = res.status === 'ok' ? '✓ 成功'
                    : `${res.status === 'timeout' ? '✗ 超时' : '✗ 失败'}${res.message ? ': ' + res.message : ''}`;
                this._flashRow(id, st);
                await this.refresh();
            } else if (ds.act === 'edit') {
                const r = await this._api('/api/tasks');
                const t = (r.tasks || []).find(x => x.id === id);
                if (t) this._fillForm(t);
            } else if (ds.act === 'del') {
                if (!confirm('确定删除该任务？')) return;
                await this._api(`/api/tasks/${id}`, { method: 'DELETE' });
                if (this.editingId === id) this._resetForm();
                await this.refresh();
            }
        } catch (e) {
            showToast('操作失败: ' + e.message, 'error');
            this.refresh();
        }
    },

    _flashRow(id, text) {
        this._status(`任务 #${id}: ${text}`);
    },

    _status(text) {
        const el = document.getElementById('task-form-status');
        if (el) el.textContent = text;
    },

    async _loadSessions() {
        const sel = document.getElementById('task-session');
        try {
            // GET /api/sessions 返回裸数组（无 success 包装），不能用 _api()
            const res = await fetch('/api/sessions');
            if (!res.ok) throw new Error('HTTP ' + res.status);
            const list = await res.json();
            const arr = Array.isArray(list) ? list : (list.sessions || []);
            if (arr.length === 0) {
                sel.innerHTML = '<option value="">暂无已保存会话，请先在左侧新建</option>';
                return;
            }
            sel.innerHTML = '<option value="">— 选择会话 —</option>' +
                arr.map(s =>
                    `<option value="${s.id}">${s.name || s.host} (${s.username}@${s.host}:${s.port})</option>`
                ).join('');
        } catch (e) {
            sel.innerHTML = `<option value="">加载会话失败: ${e.message}</option>`;
        }
    },

    _fillForm(t) {
        this.editingId = t.id;
        document.getElementById('task-name').value = t.name || '';
        document.getElementById('task-session').value = t.session_id;
        document.getElementById('task-command').value = t.command || '';
        document.getElementById('task-schedule-type').value = t.schedule_type;
        document.getElementById('task-interval').value = t.interval_seconds || 300;
        document.getElementById('task-daily').value = t.daily_time || '09:00';
        document.getElementById('task-timeout').value = t.timeout_seconds || 300;
        document.getElementById('task-enabled').checked = !!t.enabled;
        this._syncScheduleFields();
        document.getElementById('task-form-title').textContent = `编辑任务 #${t.id}`;
        document.getElementById('task-form-status').textContent = '';
    },

    _resetForm() {
        this.editingId = null;
        document.getElementById('task-name').value = '';
        document.getElementById('task-session').value = '';
        document.getElementById('task-command').value = '';
        document.getElementById('task-schedule-type').value = 'interval';
        document.getElementById('task-interval').value = 300;
        document.getElementById('task-daily').value = '09:00';
        document.getElementById('task-timeout').value = 300;
        document.getElementById('task-enabled').checked = true;
        this._syncScheduleFields();
        document.getElementById('task-form-title').textContent = '新建任务';
        document.getElementById('task-form-status').textContent = '';
    },

    _syncScheduleFields() {
        const st = document.getElementById('task-schedule-type').value;
        document.getElementById('task-field-interval').style.display =
            st === 'interval' ? '' : 'none';
        document.getElementById('task-field-daily').style.display =
            st === 'daily' ? '' : 'none';
    },

    async save() {
        const payload = {
            name: document.getElementById('task-name').value,
            session_id: parseInt(document.getElementById('task-session').value, 10) || 0,
            command: document.getElementById('task-command').value,
            schedule_type: document.getElementById('task-schedule-type').value,
            interval_seconds: parseInt(document.getElementById('task-interval').value, 10) || 300,
            daily_time: document.getElementById('task-daily').value,
            timeout_seconds: parseInt(document.getElementById('task-timeout').value, 10) || 300,
            enabled: document.getElementById('task-enabled').checked,
        };
        try {
            if (this.editingId) {
                await this._api(`/api/tasks/${this.editingId}`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload),
                });
                this._status('✓ 已保存');
            } else {
                await this._api('/api/tasks', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload),
                });
                this._status('✓ 任务已创建');
            }
            this._resetForm();
            await this.refresh();
        } catch (e) {
            this._status('✗ ' + e.message);
        }
    },

    /** toggle 开关走 change 事件委托（checkbox 不参与 click 绑定） */
    bindListEvents() {
        const list = document.getElementById('task-list');
        list.addEventListener('change', async (e) => {
            const cb = e.target.closest('input[data-toggle-id]');
            if (!cb) return;
            const id = parseInt(cb.dataset.toggleId, 10);
            try {
                await this._api(`/api/tasks/${id}`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ enabled: cb.checked }),
                });
            } catch (err) {
                showToast('操作失败: ' + err.message, 'error');
            }
            this.refresh();
        });
    },
};
