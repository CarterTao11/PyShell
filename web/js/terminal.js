/**
 * Terminal Management (terminal.js)
 * Manages xterm.js instances and SSH connections.
 */

const TerminalManager = {
    instances: new Map(),      // conn_id -> { term, fit, sessionId, eventSource }
    connectedSessions: new Set(),  // sessionId set
    activeConnId: null,
    nextConnId: 1,
    // 分屏状态: splitMode 为 'v'(左右) / 'h'(上下) / null(关闭)
    splitMode: null,
    splitPanes: [],            // [connId|null, connId|null] 当前占用两个窗格的终端
    _prevActive: null,
    _winResizeBound: false,

    async connect(sessionId, config) {
        const connId = 'conn_' + (this.nextConnId++);

        // Try to connect
        const res = await fetch('/api/ssh/connect', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(config),
        });

        const result = await res.json();

        // Handle host key unknown - ask user to confirm fingerprint
        if (result.host_key_unknown) {
            const fp = result.fingerprint || '';
            const accepted = await this._confirmHostKey(fp);
            if (!accepted) {
                alert('已取消连接');
                return false;
            }
            // User accepted, save host key and retry connection
            config.skip_host_key = true;
            // Re-send connect request, saving host key this time
            const retryRes = await fetch('/api/ssh/connect', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(config),
            });
            const retryResult = await retryRes.json();
            if (!retryResult.success) {
                alert('连接失败: ' + (retryResult.error || '未知错误'));
                return false;
            }
            // Use the retry connection result
            Object.assign(result, retryResult);
        } else if (!result.success) {
            alert('连接失败: ' + (result.error || '未知错误'));
            return false;
        }

        const actualConnId = result.conn_id || connId;

        // Create terminal UI and start streaming output
        try {
            this._createTerminal(actualConnId, sessionId, config);
            this.connectedSessions.add(sessionId);
            this._startSSE(actualConnId);
            this.activateTerminal(actualConnId);
        } catch (e) {
            console.error('Terminal init failed:', e);
            alert('终端初始化失败: ' + (e && e.message ? e.message : e));
            return false;
        }

        return true;
    },

    _createTerminal(connId, sessionId, config) {
        const container = document.getElementById('terminal-container');

        // Hide welcome
        document.getElementById('terminal-welcome').style.display = 'none';

        // Create terminal div
        const termDiv = document.createElement('div');
        termDiv.className = 'terminal-instance';
        termDiv.id = 'term-' + connId;
        container.appendChild(termDiv);

        // Create tab (insert before the split controls, keeping them at the right)
        const label = (config && (config.name || config.host)) || connId;
        const tabsContainer = document.getElementById('terminal-tabs');
        const tab = document.createElement('div');
        tab.className = 'terminal-tab';
        tab.dataset.connId = connId;
        tab.innerHTML = `<span>${label}</span><span class="terminal-tab-close">&times;</span>`;
        const controls = document.getElementById('tabs-controls');
        if (controls) {
            tabsContainer.insertBefore(tab, controls);
        } else {
            tabsContainer.appendChild(tab);
        }
        tab.addEventListener('click', (e) => {
            if (e.target.classList.contains('terminal-tab-close')) {
                this.disconnect(connId);
            } else {
                this.activateTerminal(connId);
            }
        });

        // Initialize xterm.js
        const term = new Terminal({
            cursorBlink: true,
            cursorStyle: 'block',
            fontSize: 14,
            fontFamily: "'JetBrains Mono', 'Cascadia Code', 'Consolas', monospace",
            theme: {
                background: '#000000',
                foreground: '#d4d4d4',
                cursor: '#d4d4d4',
                selectionBackground: '#264f78',
                black: '#000000',
                red: '#cd3131',
                green: '#0dbc79',
                yellow: '#e5e510',
                blue: '#2472c8',
                magenta: '#bc3fbc',
                cyan: '#11a8cd',
                white: '#e5e5e5',
                brightBlack: '#666666',
                brightRed: '#f14c4c',
                brightGreen: '#23d18b',
                brightYellow: '#f5f543',
                brightBlue: '#3b8eea',
                brightMagenta: '#d670d6',
                brightCyan: '#29b8db',
                brightWhite: '#e5e5e5',
            },
            allowTransparency: false,
            scrollback: 10000,
        });

        const fit = new FitAddon.FitAddon();
        term.loadAddon(fit);

        // Handle window resize (global, single binding) — refits all visible panes
        if (!this._winResizeBound) {
            this._winResizeBound = true;
            window.addEventListener('resize', () => this.fitVisible());
        }

        // Clicking a pane activates (focuses) that terminal
        termDiv.addEventListener('click', () => {
            if (this.activeConnId !== connId) this.activateTerminal(connId);
        });

        // Handle input
        term.onData((data) => {
            this._sendInput(connId, data);
        });

        // Handle paste
        term.attachCustomKeyEventHandler((e) => {
            if (e.ctrlKey && e.key === 'v' && e.type === 'keydown') {
                navigator.clipboard.readText().then(text => {
                    this._sendInput(connId, text);
                });
                return false;
            }
            if (e.ctrlKey && e.key === 'c' && e.type === 'keydown') {
                // Let xterm handle copy if selection exists
                if (term.hasSelection()) return true;
                this._sendInput(connId, '\x03');
                return false;
            }
            return true;
        });

        // Store instance
        this.instances.set(connId, {
            term, fit, sessionId, connId,
            termDiv, tab,
            eventSource: null,
        });

        // Show this terminal BEFORE opening/fitting it: the container is
        // display:none until activated, and fitting a hidden container
        // produces zero dimensions -> blank screen.
        this.activateTerminal(connId);

        term.open(termDiv);
        this.fitVisible();

        // Update tab display
        this._updateTabs();
    },

    _startSSE(connId) {
        const inst = this.instances.get(connId);
        if (!inst) return;

        const es = new EventSource(`/api/ssh/output/${connId}`);

        es.addEventListener('connected', () => {
            console.log('SSE connected for', connId);
        });

        // Server closed the stream because the SSH channel ended
        es.addEventListener('closed', () => {
            inst.term.write('\r\n\x1b[33m[连接已断开]\x1b[0m\r\n');
            es.close();
        });

        es.onmessage = (event) => {
            if (event.data === 'heartbeat') return;
            try {
                const decoded = atob(event.data);
                const bytes = new Uint8Array(decoded.length);
                for (let i = 0; i < decoded.length; i++) {
                    bytes[i] = decoded.charCodeAt(i);
                }
                inst.term.write(bytes);
            } catch (e) {
                console.error('SSE decode error:', e);
            }
        };

        es.onerror = () => {
            console.error('SSE error for', connId);
            es.close();
        };

        inst.eventSource = es;
    },

    _sendInput(connId, data) {
        fetch(`/api/ssh/input/${connId}`, {
            method: 'POST',
            headers: { 'Content-Type': 'text/plain' },
            body: data,
        }).catch(err => console.error('Send input error:', err));
    },

    /**
     * 全局命令模式：把一段文本（如 "ls -la\n" 或 "\x03"）发送到所有
     * 打开的终端会话。返回 {ok, total} 供状态栏展示。
     */
    async sendToAllSessions(text) {
        const targets = [...this.instances.keys()];
        let ok = 0;
        for (const connId of targets) {
            try {
                const res = await fetch(`/api/ssh/input/${connId}`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'text/plain' },
                    body: text,
                });
                const r = await res.json();
                if (r.success) ok++;
            } catch (err) {
                console.warn('sendToAllSessions error for', connId, err);
            }
        }
        return { ok, total: targets.length };
    },

    _syncResize(connId) {
        const inst = this.instances.get(connId);
        if (!inst || !inst.fit) return;
        const dims = inst.fit.proposeDimensions();
        if (dims && dims.rows > 0 && dims.cols > 0) {
            fetch('/api/ssh/resize', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    conn_id: connId,
                    rows: dims.rows,
                    cols: dims.cols,
                }),
            }).catch(() => {});
        }
    },

    activateTerminal(connId) {
        const inst = this.instances.get(connId);
        if (!inst) return;

        this._prevActive = this.activeConnId;
        this.activeConnId = connId;

        // Update tab highlight
        document.querySelectorAll('.terminal-tab').forEach(el => {
            el.classList.remove('active');
        });
        const tab = document.querySelector(`.terminal-tab[data-conn-id="${connId}"]`);
        if (tab) tab.classList.add('active');

        // Pane highlight
        document.querySelectorAll('.terminal-instance').forEach(el => {
            el.classList.remove('active');
        });
        inst.termDiv.classList.add('active');

        if (this.splitMode) {
            // Make sure the activated terminal occupies a pane; if it came
            // from a tab (or is brand new), it takes the "other" pane next
            // to the one the user was looking at.
            if (!this.splitPanes.includes(connId)) {
                let idx = this.splitPanes.indexOf(null);
                if (idx === -1) {
                    const prevIdx = this._prevActive ? this.splitPanes.indexOf(this._prevActive) : -1;
                    idx = prevIdx === 0 ? 1 : 0;
                }
                this.splitPanes[idx] = connId;
            }
            this._applyLayout();
        } else {
            // Single mode: hide all others
            document.querySelectorAll('.terminal-instance').forEach(el => {
                if (el !== inst.termDiv) el.classList.remove('active');
            });
        }

        // Refit after layout settles, then sync PTY size
        setTimeout(() => this.fitVisible(), 100);
        inst.term.focus();
    },

    /**
     * 切换分屏模式。
     * @param {'v'|'h'} mode 'v'=左右分屏, 'h'=上下分屏; 再次点击同一模式则关闭
     */
    setSplitMode(mode) {
        if (this.splitMode === mode) {
            mode = null;  // toggle off
        }
        this.splitMode = mode;

        if (this.splitMode) {
            // Fill panes: active terminal first, then most recent other
            const others = Array.from(this.instances.keys())
                .filter(id => id !== this.activeConnId);
            this.splitPanes = [this.activeConnId, others[0] || null];
        } else {
            this.splitPanes = [];
        }

        // Update toggle buttons
        const bv = document.getElementById('btn-split-v');
        const bh = document.getElementById('btn-split-h');
        if (bv) bv.classList.toggle('active', this.splitMode === 'v');
        if (bh) bh.classList.toggle('active', this.splitMode === 'h');

        this._applyLayout();
    },

    /** 根据 splitMode/splitPanes 给终端容器和窗格设置布局类并重新 fit */
    _applyLayout() {
        const container = document.getElementById('terminal-container');
        if (!container) return;
        container.classList.toggle('split-v', this.splitMode === 'v');
        container.classList.toggle('split-h', this.splitMode === 'h');

        this.instances.forEach(inst => {
            inst.termDiv.classList.remove('pane-a', 'pane-b');
        });
        if (this.splitMode) {
            const [a, b] = this.splitPanes;
            if (a && this.instances.has(a)) {
                this.instances.get(a).termDiv.classList.add('pane-a');
            }
            if (b && this.instances.has(b)) {
                this.instances.get(b).termDiv.classList.add('pane-b');
            }
        }
        this.fitVisible();
    },

    /** 对所有可见窗格执行 fit 并把尺寸同步到远端 PTY */
    fitVisible() {
        const container = document.getElementById('terminal-container');
        if (!container) return;
        const isSplit = container.classList.contains('split-v')
            || container.classList.contains('split-h');
        let visible = [];
        if (isSplit) {
            visible = this.splitPanes.filter(id => id && this.instances.has(id));
        } else if (this.activeConnId && this.instances.has(this.activeConnId)) {
            visible = [this.activeConnId];
        }
        visible.forEach(id => {
            const inst = this.instances.get(id);
            if (!inst || !inst.fit) return;
            try {
                inst.fit.fit();
            } catch (e) { /* ignore transient layout errors */ }
            this._syncResize(id);
        });
    },

    async disconnect(connId) {
        const inst = this.instances.get(connId);
        if (!inst) return;

        // Close SSE
        if (inst.eventSource) {
            inst.eventSource.close();
        }

        // Remove from connected sessions
        this.connectedSessions.delete(inst.sessionId);

        // API disconnect
        try {
            await fetch('/api/ssh/disconnect', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ conn_id: connId }),
            });
        } catch (e) {
            console.error('Disconnect error:', e);
        }

        // Remove terminal UI
        inst.tab.remove();
        inst.termDiv.remove();

        inst.term.dispose();
        this.instances.delete(connId);

        // Split-mode cleanup
        if (this.splitMode) {
            const idx = this.splitPanes.indexOf(connId);
            if (idx !== -1) {
                // Try to backfill the freed pane with a tab-only terminal
                const candidate = Array.from(this.instances.keys())
                    .find(id => !this.splitPanes.includes(id));
                this.splitPanes[idx] = candidate || null;
            }
            // With fewer than two terminals a split makes no sense
            if (this.instances.size < 2) {
                this.splitMode = null;
                this.splitPanes = [];
                const bv = document.getElementById('btn-split-v');
                const bh = document.getElementById('btn-split-h');
                if (bv) bv.classList.remove('active');
                if (bh) bh.classList.remove('active');
            }
        }

        if (this.activeConnId === connId) {
            this.activeConnId = null;
        }

        // Re-apply layout: clears split classes if we just left split mode
        this._applyLayout();

        // Update tabs
        this._updateTabs();

        // Switch to another terminal or show welcome
        const remaining = Array.from(this.instances.keys());
        if (remaining.length > 0) {
            this.activateTerminal(remaining[0]);
        } else {
            document.getElementById('terminal-welcome').style.display = 'flex';
        }

        // Refresh session list
        SessionManager.render();
    },

    disconnectAll() {
        Array.from(this.instances.keys()).forEach(connId => {
            this.disconnect(connId);
        });
    },

    _updateTabs() {
        // No-op for now
    },

    async _confirmHostKey(fingerprint) {
        return new Promise((resolve) => {
            document.getElementById('hostkey-fingerprint').textContent = fingerprint;
            document.getElementById('hostkey-overlay').classList.remove('hidden');

            const acceptBtn = document.getElementById('btn-hostkey-accept');
            const rejectBtn = document.getElementById('btn-hostkey-reject');

            const cleanup = () => {
                document.getElementById('hostkey-overlay').classList.add('hidden');
                acceptBtn.replaceWith(acceptBtn.cloneNode(true));
                rejectBtn.replaceWith(rejectBtn.cloneNode(true));
            };

            acceptBtn.addEventListener('click', () => {
                cleanup();
                resolve(true);
            }, { once: true });

            rejectBtn.addEventListener('click', () => {
                cleanup();
                resolve(false);
            }, { once: true });
        });
    },
};