/**
 * Terminal Management (terminal.js)
 * Manages xterm.js instances and SSH connections.
 */

const TerminalManager = {
    instances: new Map(),      // conn_id -> { term, fit, sessionId, eventSource }
    connectedSessions: new Set(),  // sessionId set
    // 会话连接状态: sessionId -> 'connecting' | 'connected' | 'error'
    // （connectedSessions 只能表达"连上了没有"，状态灯还要区分"正在连"和"连接失败"）
    connectionStates: new Map(),
    activeConnId: null,
    nextConnId: 1,
    // 分屏状态: splitV 为 true 表示左右分屏, splitH 为 true 表示上下分屏
    // 两者同时为 true 时表示四宫格
    splitV: false,
    splitH: false,
    splitPanes: [],            // [connId|null, ...] 当前占用窗格的终端 (2或4个)
    _prevActive: null,
    _winResizeBound: false,
    // 目录同步: conn_id -> 当前工作目录
    cwdMap: new Map(),
    // home 目录: conn_id -> ~ 展开结果（cd / cd ~ / 打开 SFTP 都要用）
    homeMap: new Map(),
    // 上一次目录: conn_id -> OLDPWD（支持 cd -）
    prevCwdMap: new Map(),
    // 目录同步防抖: cd 防抖: 快速连续 cd 时只触发最后一次
    _cdDebounceTimer: null,
    _cdPending: null,  // { connId, path }

    async connect(sessionId, config) {
        const connId = 'conn_' + (this.nextConnId++);

        // 状态灯：一进 connect 就点黄灯（含输密码/换主机指纹的等待期）
        this._setSessionState(sessionId, 'connecting');

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
                showToast('已取消连接', 'warning');
                this._setSessionState(sessionId, null);
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
                showToast('连接失败: ' + (retryResult.error || '未知错误'), 'error');
                this._setSessionState(sessionId, 'error');
                return false;
            }
            // Use the retry connection result
            Object.assign(result, retryResult);
        } else if (!result.success) {
            showToast('连接失败: ' + (result.error || '未知错误'), 'error');
            this._setSessionState(sessionId, 'error');
            return false;
        }

        const actualConnId = result.conn_id || connId;

        // Create terminal UI and start streaming output
        try {
            // 先取到 home 目录：终端一旦可输入，cd ~ / 打开 SFTP 就必须能定位，
            // 放在创建终端之后会有一段"目录未知"的窗口期
            await this._initHomeDir(actualConnId);
            this._createTerminal(actualConnId, sessionId, config);
            this.connectedSessions.add(sessionId);
            this._setSessionState(sessionId, 'connected');
            this._startSSE(actualConnId);
            this.activateTerminal(actualConnId);
        } catch (e) {
            console.error('Terminal init failed:', e);
            showToast('终端初始化失败: ' + (e && e.message ? e.message : e), 'error');
            this._setSessionState(sessionId, 'error');
            return false;
        }

        return true;
    },

    /** 改一条会话的连接状态并立刻刷状态灯（不动列表结构，避免丢滚动位置） */
    _setSessionState(sessionId, state) {
        if (sessionId === undefined || sessionId === null) return;
        if (state) this.connectionStates.set(sessionId, state);
        else this.connectionStates.delete(sessionId);
        if (typeof SessionManager !== 'undefined' && SessionManager.refreshStatus) {
            SessionManager.refreshStatus();
        }
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
        // 右键：自绘菜单（复制为新标签页），不弹浏览器原生菜单
        tab.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            e.stopPropagation();
            this._showTabContextMenu(e, connId);
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

        // Ctrl+F 归"终端内搜索"：返回 false 让 xterm 不要把 ^F 发给远端
        // （不拦的话 bash/readline 会把它当成 forward-char，在 vim 里还会改光标）
        // 真正的打开动作在 app.js 的 document 监听里做，那里才拦得住浏览器自带的查找框
        term.attachCustomKeyEventHandler((e) => {
            if (e.type !== 'keydown' || e.altKey) return true;
            if (!(e.ctrlKey || e.metaKey)) return true;
            if (e.key !== 'f' && e.key !== 'F') return true;
            return false;
        });

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

        // Handle paste / ctrl+c
        // Ctrl+V：只拦截 xterm 自己的按键处理（否则 xterm 会把 Ctrl+V 当 0x16
        // 控制符发给 shell），随后由浏览器默认粘贴触发 xterm 的原生 paste 事件，
        // 经 onData 统一发送——只粘贴一次。之前这里还手动 readText() 发了一遍，
        // 而自定义 handler 返回 false 并不会 preventDefault，浏览器默认粘贴
        // 照常触发，两条路叠加导致内容被粘贴两遍。
        term.attachCustomKeyEventHandler((e) => {
            // 当收藏夹弹框显示时，拦截方向键、回车、Esc
            const favPanel = document.getElementById('terminal-fav-panel');
            if (favPanel && favPanel.style.display !== 'none') {
                if (e.key === 'ArrowDown' || e.key === 'ArrowUp' ||
                    e.key === 'Enter' || e.key === 'Escape' || e.key === 'Tab' ||
                    (e.ctrlKey && (e.key === 'ArrowDown' || e.key === 'ArrowUp'))) {
                    return false; // 阻止 xterm 处理，让 document 事件处理
                }
            }

            if (e.ctrlKey && e.key === 'v' && e.type === 'keydown') {
                return false;
            }
            if (e.ctrlKey && e.key === 'c' && e.type === 'keydown') {
                // Let xterm handle copy if selection exists
                if (term.hasSelection()) return true;
                this._sendInput(connId, '\x03');
                return false;
            }
            // Ctrl+M 触发收藏命令选择器
            if (e.ctrlKey && e.key === 'm' && e.type === 'keydown') {
                // 获取终端容器的位置
                const termContainer = document.getElementById('terminal-container');
                const rect = termContainer ? termContainer.getBoundingClientRect() : { left: 0, top: 0, width: 400, height: 300 };
                // 触发自定义事件，传递位置信息
                window.dispatchEvent(new CustomEvent('show-favorites', {
                    detail: {
                        x: rect.left + rect.width / 2,
                        y: rect.top + rect.height / 2
                    }
                }));
                return false;
            }
            return true;
        });

        // 选中即复制（copy-on-select）
        // 主路径：termDiv 上的 mouseup —— 同步调用、处于用户手势内，Clipboard
        // API 不会因"缺少用户激活"被拒（Firefox 尤其严格）。
        termDiv.addEventListener('mouseup', () => {
            if (term.hasSelection()) this._copyToClipboard(term.getSelection());
        });

        // 兜底路径：onSelectionChange + 防抖 —— 覆盖在终端外松开鼠标、双击选词
        // 等不以 termDiv mouseup 收尾的情况；连续变化只取最终选区。点击空白处
        // 取消选区时 hasSelection 为 false，不会误复制。
        let selCopyTimer = null;
        term.onSelectionChange(() => {
            clearTimeout(selCopyTimer);
            selCopyTimer = setTimeout(() => {
                if (!term.hasSelection()) return;
                this._copyToClipboard(term.getSelection());
            }, 200);
        });

        // Store instance
        const inst = {
            term, fit, sessionId, connId,
            termDiv, tab,
            eventSource: null,
            config: config || null,    // 重连 / 复制新标签都要复用这份连接参数
            closed: false,             // 远端已断开（下一次输入时无感重连）
            reconnecting: false,      // 重连进行中，期间输入攒进 pendingInput
            pendingInput: '',         // 断线期间攒下的、待重连成功后补发的输入
        };
        this._outReset(inst);        // 输出管道的队列/水位状态
        this.instances.set(connId, inst);

        // Show this terminal BEFORE opening/fitting it: the container is
        // display:none until activated, and fitting a hidden container
        // produces zero dimensions -> blank screen.
        this.activateTerminal(connId);

        term.open(termDiv);

        // 兜底隐藏 xterm 的字符测量元素（内容为 32 个 "W"）。正常由
        // vendor/xterm.css 的 .xterm-char-measure-element 规则隐藏，但若浏览器
        // 缓存了坏的/旧的样式表，该规则缺失，元素会显示在终端顶部
        // （.xterm-helpers 容器就在 top:0）。这里用内联样式强制隐藏：
        // 内联样式优先级最高；visibility:hidden 不影响 offsetWidth，字符度量
        // 功能不受影响。注意不能用 display:none——那会让测量结果变成 0。
        const measureEl = termDiv.querySelector('.xterm-char-measure-element');
        if (measureEl) {
            measureEl.style.visibility = 'hidden';
            measureEl.style.position = 'absolute';
            measureEl.style.left = '-9999em';
            measureEl.style.top = '0';
        }

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
            es.close();
            inst.closed = true;
            this.connectedSessions.delete(inst.sessionId);
            this._setSessionState(inst.sessionId, 'error');
            // 不销毁终端界面：用户下一次输入时走 _reconnect 无感接上
            this._writeStatus(inst, '\r\n\x1b[33m[连接已断开，等待下次命令自动重连]\x1b[0m\r\n');
        });

        es.onmessage = (event) => {
            if (event.data === 'heartbeat') return;
            try {
                const decoded = atob(event.data);
                const bytes = new Uint8Array(decoded.length);
                for (let i = 0; i < decoded.length; i++) {
                    bytes[i] = decoded.charCodeAt(i);
                }
                // 不直接 term.write：交给有界队列限速（见 _feedOutput）
                this._feedOutput(inst, bytes);
            } catch (e) {
                console.error('SSE decode error:', e);
            }
        };

        // 后端因为浏览器跟不上丢过字节：在终端里明说，别让用户以为看漏了
        es.addEventListener('overflow', (event) => {
            const lost = parseInt(event.data, 10) || 0;
            if (lost > 0) this._noteDropped(inst, lost);
        });

        es.onerror = () => {
            console.error('SSE error for', connId);
            es.close();
        };

        inst.eventSource = es;
    },

    // ===== 终端输出管道：有界队列 + 背压 =====
    // xterm 的 write() 是异步的，它的内部写队列没有上限。`docker logs -f` 这类命令
    // 一秒能吐几十 MB，如果收到一条 SSE 就 write 一条，写队列会无限增长，
    // 浏览器标签最终被 OOM 干掉（表现就是"浏览器退出了"）。
    // 这里自己做有界队列：一次只喂一块，等 xterm 解析回调再喂下一块；
    // 队列超过高水位就丢最旧的（用户盯的是尾部），并把丢了多少明确写进终端。
    OUTPUT_HIGH_WATER: 4 * 1024 * 1024,   // 待解析字节上限
    OUTPUT_CHUNK: 256 * 1024,             // 单块最大字节
    OUTPUT_DROP_NOTICE: 1024 * 1024,      // 累计丢到 1MB 才提示一次，免得刷屏
    OUTPUT_ACK_STEP: 512 * 1024,          // 每消费 512KB 向后端归还一次流量额度
    OUTPUT_ACK_MAX_WAIT: 500,             // 小流量时最多攒 500ms 也要确认，免得后端干等

    _humanBytes(n) {
        if (n < 1024) return n + ' B';
        if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
        if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB';
        return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB';
    },

    _outReset(inst) {
        if (inst && inst.outAckPending) this._flushAck(inst);   // 别把额度欠着不说
        inst.outQueue = [];
        inst.outBytes = 0;
        inst.outWriting = false;
        inst.outDropped = 0;
        inst.outDroppedPrinted = 0;
        inst.outAckPending = 0;
        inst.outAckLast = 0;
    },

    /**
     * 把"已消费"的消息上报给后端，归还流量额度。
     * 写入完成或丢弃都算消费掉（否则被丢掉的那部分额度永远还不回去，后端会一直卡住）。
     */
    _ackOutput(inst, n) {
        if (!n || !inst) return;
        inst.outAckPending = (inst.outAckPending || 0) + n;
        const now = Date.now();
        if (inst.outAckPending >= this.OUTPUT_ACK_STEP
            || now - (inst.outAckLast || 0) >= this.OUTPUT_ACK_MAX_WAIT) {
            this._flushAck(inst);
        }
    },

    _flushAck(inst) {
        const n = inst.outAckPending;
        if (!n || !inst.connId || typeof fetch !== 'function') return;
        inst.outAckPending = 0;
        inst.outAckLast = Date.now();
        // keepalive 让页面卸载时也能把额度还回去；失败也无所谓——后端 5 秒等不到
        // 确认会自动降级成不限流，不会把终端冻死
        fetch(`/api/ssh/ack/${inst.connId}`, {
            method: 'POST',
            body: String(n),
            headers: { 'Content-Type': 'text/plain' },
            keepalive: true,
        }).catch(() => {});
    },

    /** SSE 每来一条消息都走这里：切块入队、限水位、触发泵送 */
    _feedOutput(inst, bytes) {
        if (!inst.outQueue) this._outReset(inst);
        const n = bytes.length;
        if (!n) return;
        for (let off = 0; off < n; off += this.OUTPUT_CHUNK) {
            const part = bytes.subarray(off, Math.min(n, off + this.OUTPUT_CHUNK));
            inst.outQueue.push(part);
            inst.outBytes += part.length;
        }
        // 超水位：丢最旧的，保住最新的
        while (inst.outBytes > this.OUTPUT_HIGH_WATER && inst.outQueue.length > 1) {
            const dropped = inst.outQueue.shift();
            inst.outBytes -= dropped.length;
            inst.outDropped += dropped.length;
            // 丢掉的数据也算"消费掉了"，必须回执，否则后端会一直等这批额度
            this._ackOutput(inst, dropped.length);
        }
        this._pumpOutput(inst);
    },

    /** 一次只写一块，写完了靠 xterm 的回调继续 —— 这是对 xterm 的唯一背压手段 */
    _pumpOutput(inst) {
        if (inst.outWriting) return;
        const chunk = inst.outQueue.shift();
        if (!chunk) {
            this._flushAck(inst);
            this._flushDropNotice(inst);
            return;
        }
        inst.outBytes -= chunk.length;
        inst.outWriting = true;
        this._flushDropNotice(inst);
        inst.term.write(chunk, () => {
            inst.outWriting = false;
            this._ackOutput(inst, chunk.length);   // 这一块解析完了，归还额度
            this._pumpOutput(inst);
        });
    },

    /** 丢弃提示按 1MB 为单位节流，洪水期也不会把屏幕刷满 */
    _flushDropNotice(inst) {
        const pending = inst.outDropped - inst.outDroppedPrinted;
        if (pending < this.OUTPUT_DROP_NOTICE && inst.outQueue && inst.outQueue.length > 0) return;
        if (pending <= 0) return;
        inst.outDroppedPrinted = inst.outDropped;
        this._noteDropped(inst, pending);
    },

    _noteDropped(inst, bytes) {
        if (!inst || !inst.term || !bytes) return;
        // 丢弃可能把某个转义序列切断，先复位一次颜色，别让后续输出整屏染色
        const text = `\r\n\x1b[0m\x1b[33m[输出过快，浏览器来不及渲染，已丢弃约 ${this._humanBytes(bytes)} 未显示]\x1b[0m\r\n`;
        inst.term.write(text);
    },

    // ===== 终端输出搜索（Ctrl+F）=====
    // 不用浏览器自带的查找：它搜的是 HTML 文本，而终端内容在 canvas 里，命中不了也高亮不了。
    // 这里直接扫 xterm 的缓冲区行文本，用 select() 选中 + scrollToLine 定位。
    searchState: { open: false, query: '', hits: [], index: -1 },

    _searchTerm() {
        const inst = this.instances.get(this.activeConnId);
        return inst && inst.term ? inst.term : null;
    },

    openSearch() {
        const box = document.getElementById('terminal-search');
        const input = document.getElementById('terminal-search-input');
        if (!box || !input) return;
        if (!this._searchTerm()) {
            showToast('还没有打开的终端', 'warning');
            return;
        }
        box.classList.remove('hidden');
        this.searchState.open = true;
        input.focus();
        input.select();
        if (this.searchState.query) this._runSearch(this.searchState.query, true);
    },

    closeSearch() {
        const box = document.getElementById('terminal-search');
        if (box) box.classList.add('hidden');
        const st = this.searchState;
        st.open = false;
        st.hits = [];
        st.index = -1;
        this._setSearchCount('');
        const term = this._searchTerm();
        if (term) {
            try { term.clearSelection(); } catch (e) { /* 已无选择 */ }
            try { term.focus(); } catch (e) { /* ignore */ }
        }
    },

    _setSearchCount(text) {
        const el = document.getElementById('terminal-search-count');
        if (el) el.textContent = text;
    },

    /** 扫当前活动终端的缓冲区，返回 [{row, col, len}]（row 为缓冲区绝对行号） */
    _collectHits(term, query) {
        const hits = [];
        if (!term || !query) return hits;
        const buf = term.buffer.active;
        const lower = query.toLowerCase();
        const total = buf.length;
        for (let y = 0; y < total; y++) {
            const line = buf.getLine(y);
            if (!line) continue;
            // 折行的续行跳过：续行只含后半截文本，列号会和屏幕对不上
            if (line.isWrapped) continue;
            const text = line.translateToString(true).toLowerCase();
            let from = 0;
            while (true) {
                const at = text.indexOf(lower, from);
                if (at < 0) break;
                hits.push({ row: y, col: at, len: query.length });
                from = at + Math.max(1, query.length);
                if (hits.length >= 5000) return hits;   // 超长回滚缓冲的保护
            }
        }
        return hits;
    },

    _runSearch(query, keepIndex) {
        const st = this.searchState;
        const term = this._searchTerm();
        st.query = query || '';
        if (!term || !st.query) {
            st.hits = [];
            st.index = -1;
            this._setSearchCount(st.query ? '0/0' : '');
            return;
        }
        st.hits = this._collectHits(term, st.query);
        // 首次搜索默认落在最靠下的一处（和 tail -f 盯日志的直觉一致）
        if (!keepIndex || st.index < 0 || st.index >= st.hits.length) {
            st.index = st.hits.length > 0 ? st.hits.length - 1 : -1;
        }
        this._focusHit();
    },

    searchStep(dir) {
        const st = this.searchState;
        if (!st.open || !st.query) return;
        if (st.hits.length === 0) {
            this._runSearch(st.query, false);
            return;
        }
        st.index = (st.index + (dir > 0 ? 1 : -1) + st.hits.length) % st.hits.length;
        this._focusHit();
    },

    _focusHit() {
        const st = this.searchState;
        const term = this._searchTerm();
        const hit = st.hits[st.index];
        if (!term || !hit) {
            this._setSearchCount('0/0');
            return;
        }
        try {
            term.select(hit.col, hit.row, hit.len);
            const rows = term.rows || 24;
            term.scrollToLine(Math.max(0, hit.row - Math.floor(rows / 3)));
        } catch (e) {
            console.warn('[search] focus failed:', e);
        }
        this._setSearchCount(`${st.index + 1}/${st.hits.length}`);
    },

    _sendInput(connId, data) {
        const inst = this.instances.get(connId);
        if (!inst) return;
        // 先本地解析输入流以跟踪 cwd（粘贴整行、多字符输入也能识别），再发往远端
        this._feedInput(connId, data);

        // 重连进行中：输入先攒着，接上后一次性补发，不丢字符
        if (inst.reconnecting) {
            inst.pendingInput = (inst.pendingInput || '') + data;
            return;
        }
        // 已断开：把输入攒起来并触发一次自动重连（无感：用户照常敲命令即可）
        if (inst.closed) {
            inst.pendingInput = (inst.pendingInput || '') + data;
            this._reconnect(inst);
            return;
        }

        fetch(`/api/ssh/input/${connId}`, {
            method: 'POST',
            headers: { 'Content-Type': 'text/plain' },
            body: data,
        }).then(res => {
            if (!res.ok) throw new Error('HTTP ' + res.status);
        }).catch(err => {
            console.error('Send input error:', err);
            inst.closed = true;
            inst.pendingInput = (inst.pendingInput || '') + data;
            this._reconnect(inst);
        });
    },

    /**
     * 从终端屏幕回读光标所在行，去掉提示符，得到 shell 里真实的命令行。
     * 只在本地缓冲不可信（Tab 补全 / 上下历史）时使用：
     *   user@host:/usr# cd /usr/local/   ->  "cd /usr/local/"
     * 拿不到（折行、提示符识别不出）时返回 null，调用方保持旧目录而不跳错。
     */
    _screenCommandLine(inst) {
        try {
            const buf = inst && inst.term && inst.term.buffer && inst.term.buffer.active;
            if (!buf || typeof buf.getLine !== 'function') return null;
            const row = (buf.baseY || 0) + (buf.cursorY || 0);
            const line = buf.getLine(row);
            if (!line) return null;
            const text = String((line.translateToString && line.translateToString(true)) || '');
            if (!text) return null;

            // 常见提示符以 $ / # / % / > / ❯ / → 结尾，取最后一个之后的内容
            const marks = /(\$|#|%|>|❯|→)\s+/g;
            let start = 0;
            let m;
            while ((m = marks.exec(text)) !== null) start = m.index + m[0].length;
            const cmd = text.slice(start).trim();
            return cmd || null;
        } catch (e) {
            return null;
        }
    },

    /**
     * 输入流解析：像行编辑器一样维护"当前行 + 光标"，行结束时解析 cd。
     * 旧实现只认单字符和单独的 \r：粘贴整行、方向键改动、Tab 补全、
     * 历史命令都会让跟踪目录失真，进而把 SFTP 带到错误目录。
     */
    _feedInput(connId, data) {
        const inst = this.instances.get(connId);
        if (!inst || typeof data !== 'string' || !data) return;
        if (inst._inputBuffer === undefined) inst._inputBuffer = '';
        if (inst._inputCursor === undefined || inst._inputCursor > inst._inputBuffer.length) {
            inst._inputCursor = inst._inputBuffer.length;
        }
        const buf = () => inst._inputBuffer;
        const len = () => inst._inputBuffer.length;

        const insert = (s) => {
            inst._inputBuffer = buf().slice(0, inst._inputCursor) + s + buf().slice(inst._inputCursor);
            inst._inputCursor += s.length;
        };
        const delBefore = (n) => {
            const from = Math.max(0, inst._inputCursor - n);
            inst._inputBuffer = buf().slice(0, from) + buf().slice(inst._inputCursor);
            inst._inputCursor = from;
        };

        // 转义序列整体作为一个 token，普通字符一个 token
        const tokens = data.match(
            /\x1b\[[0-9;?]*[ -\/]*[@-~]|\x1bO[A-Za-z]|\x1b[()][A-Za-z0-9]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|[\s\S]/g
        ) || [];

        for (const tok of tokens) {
            // ---- CSI 序列（方向键 / Home / End / Delete / 历史 / 括号粘贴）
            if (tok.length > 1 && tok.charCodeAt(0) === 0x1b) {
                const csi = tok.match(/^\x1b\[([0-9;?]*)[ -\/]*([@-~])$/);
                const ss3 = tok.match(/^\x1bO([A-Za-z])$/);
                if (csi) {
                    const num = parseInt(csi[1], 10) || 1;
                    const fin = csi[2];
                    if (fin === 'D') inst._inputCursor = Math.max(0, inst._inputCursor - num);
                    else if (fin === 'C') inst._inputCursor = Math.min(len(), inst._inputCursor + num);
                    else if (fin === 'H') inst._inputCursor = 0;          // Home
                    else if (fin === 'F') inst._inputCursor = len();      // End
                    else if (fin === '~') {
                        if (csi[1] === '3') {                            // Delete
                            inst._inputBuffer = buf().slice(0, inst._inputCursor) + buf().slice(inst._inputCursor + 1);
                        } else if (csi[1] === '1' || csi[1] === '7') {
                            inst._inputCursor = 0;
                        } else if (csi[1] === '4' || csi[1] === '8') {
                            inst._inputCursor = len();
                        }
                        // 200~/201~ 是括号粘贴的起止标记，忽略即可
                    } else if (fin === 'A' || fin === 'B') {
                        // 上/下历史：shell 会改写整行，本地缓冲不再可信
                        inst._inputUnreliable = true;
                    }
                    continue;
                }
                if (ss3) {
                    const k = ss3[1];
                    if (k === 'D') inst._inputCursor = Math.max(0, inst._inputCursor - 1);
                    else if (k === 'C') inst._inputCursor = Math.min(len(), inst._inputCursor + 1);
                    else if (k === 'H') inst._inputCursor = 0;
                    else if (k === 'F') inst._inputCursor = len();
                    else if (k === 'A' || k === 'B') inst._inputUnreliable = true;
                    continue;
                }
                continue;   // 其它控制序列（OSC / 字符集切换等）不影响命令行
            }

            // ---- 普通字符 / 控制键
            if (tok === '\r' || tok === '\n') {
                const line = inst._inputBuffer;
                const unreliable = inst._inputUnreliable === true;
                inst._inputBuffer = '';
                inst._inputCursor = 0;
                inst._inputUnreliable = false;
                if (!unreliable) {
                    this._onLineSubmitted(connId, line);
                } else {
                    // 被 Tab 补全 / 历史命令改写过：本地缓冲已失真（用户敲
                    // `cd /usr/lo<Tab>` 时远端其实是 `cd /usr/local/`），
                    // 从终端屏幕回读这一行才是真命令。
                    const screen = this._screenCommandLine(inst);
                    if (screen) this._onLineSubmitted(connId, screen);
                }
            } else if (tok === '\x7f' || tok === '\b') {
                delBefore(1);                                  // Backspace
            } else if (tok === '\t') {
                inst._inputUnreliable = true;                  // Tab 补全会改写该 token
            } else if (tok === '\x15') {
                inst._inputBuffer = ''; inst._inputCursor = 0; // Ctrl+U
            } else if (tok === '\x0b') {
                inst._inputBuffer = buf().slice(0, inst._inputCursor);  // Ctrl+K
            } else if (tok === '\x17') {
                // Ctrl+W：删掉光标前一个词（bash 以空白为词边界）
                const before = buf().slice(0, inst._inputCursor);
                const cut = before.replace(/[^\s]+$/, '');
                delBefore(before.length - cut.length);
            } else if (tok === '\x01') {
                inst._inputCursor = 0;                         // Ctrl+A
            } else if (tok === '\x05') {
                inst._inputCursor = len();                     // Ctrl+E
            } else if (tok === '\x03') {
                inst._inputBuffer = ''; inst._inputCursor = 0; // Ctrl+C
            } else if (tok.charCodeAt(0) >= 32) {
                insert(tok);                                   // 可打印字符
            }
        }
    },

    /**
     * 一行命令提交后解析 cd 命令，成功则更新跟踪目录并通知 SFTP 跟随
     */
    _onLineSubmitted(connId, line) {
        const text = (line || '').trim();
        if (!text || text.startsWith('#')) return;

        const cwdBefore = this.cwdMap.get(connId) || '/';
        const home = this.homeMap.get(connId) || cwdBefore;
        const prev = this.prevCwdMap.get(connId) || null;

        // 按命令分隔符切分：`cd /a && ls`、`ls; cd /b`、`cd /c | less` 都能识别
        let finalCwd = null;   // null = 整行没有可解析的 cd
        for (const seg of text.split(/(?:&&|\|\||;|&|\|)/)) {
            const arg = this._parseCdCommand(seg);
            if (arg === null) continue;
            const resolved = this._resolvePath(arg, finalCwd || cwdBefore, home, prev);
            // 解析不出来（cd $VAR、无历史的 cd - 等）不猜，保持原目录
            if (resolved === null) return;
            finalCwd = resolved;
        }
        if (finalCwd === null) return;

        // 即使解析出的目录与跟踪值相同也通知一次：面板可能因为上一次列目录
        // 失败停在旧目录上，这次让它自己纠正回来（同目录时面板会直接跳过）
        if (finalCwd !== cwdBefore) this.prevCwdMap.set(connId, cwdBefore);
        this.cwdMap.set(connId, finalCwd);
        this._onTerminalDirChange(connId, finalCwd);
    },

    /** 写剪贴板：优先 Clipboard API，被拒（如失去用户激活）时退回 execCommand */
    _copyToClipboard(text) {
        const done = () => console.info(`[PyShell] 已自动复制 ${text.length} 个字符`);
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text).then(done).catch(() => {
                this._copyFallback(text) ? done() : console.warn('[PyShell] 自动复制失败（剪贴板被拒绝）');
            });
        } else {
            this._copyFallback(text) ? done() : console.warn('[PyShell] 自动复制失败（剪贴板被拒绝）');
        }
    },

    _copyFallback(text) {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        let ok = false;
        try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
        ta.remove();
        return ok;
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
                // 全局命令里的 cd 也要被目录跟踪识别（SFTP 跟随）
                this._feedInput(connId, text);
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

    // ===== 目录同步（终端 ↔ SFTP）=====

    /**
     * 获取连接的当前跟踪目录，若未知则尝试从后端获取 home 目录
     */
    async getTrackedCwd(connId) {
        // 已有有效跟踪目录时直接返回，不发起网络请求
        const existing = this.cwdMap.get(connId);
        if (existing && existing.startsWith('/')) return existing;
        // 未知时先取 home（连接时已取过，这里只是兜底）
        if (!this.homeMap.has(connId)) await this._initHomeDir(connId);
        return this.cwdMap.get(connId) || this.homeMap.get(connId) || '/';
    },

    /** 取连接的 home 目录（连接时已缓存，通常不发请求） */
    async getHomeDir(connId) {
        if (!this.homeMap.has(connId)) await this._initHomeDir(connId);
        return this.homeMap.get(connId) || this.cwdMap.get(connId) || '/';
    },

    /**
     * 初始化连接的 home 目录（连接成功后调用）
     * 记录 homeMap（供 ~ 展开用），仅在 cwdMap 尚无有效值时初始化 cwdMap
     */
    async _initHomeDir(connId) {
        const tracked = this.cwdMap.get(connId);
        if (this.homeMap.has(connId) && tracked && tracked.startsWith('/')) {
            return this.homeMap.get(connId);
        }
        try {
            const res = await fetch(`/api/ssh/homedir/${connId}`);
            const result = await res.json();
            if (result.success && result.home && result.home.startsWith('/')) {
                const home = this._normalizePath(result.home);
                this.homeMap.set(connId, home);
                const current = this.cwdMap.get(connId);
                if (!current || !current.startsWith('/')) this.cwdMap.set(connId, home);
                return home;
            }
        } catch (e) {
            console.warn('_initHomeDir error:', e);
        }
        // 失败时仅在没有其他值时存储根目录
        if (!this.cwdMap.has(connId)) this.cwdMap.set(connId, '/');
        if (!this.homeMap.has(connId)) this.homeMap.set(connId, this.cwdMap.get(connId) || '/');
        return this.homeMap.get(connId);
    },

    /**
     * 规范化路径：去多余斜杠、去尾部斜杠
     */
    _normalizePath(p) {
        if (!p) return '/';
        let s = String(p).replace(/\/\/+/g, '/');
        if (s.length > 1) s = s.replace(/\/+$/, '');
        return s || '/';
    },

    /**
     * 解析路径（支持 ~, 相对路径, 绝对路径, cd -）。
     * 返回 null 表示"本地无法得知结果"（变量展开、通配符、~user 等），
     * 调用方应放弃更新跟踪目录，而不是猜一个错误路径。
     */
    _resolvePath(path, cwd, home, prev) {
        const arg = (path || '').trim();
        if (!arg || arg === '~') return this._normalizePath(home || '/');
        if (arg === '-') return prev ? this._normalizePath(prev) : null;  // cd - => OLDPWD
        if (arg.startsWith('~/')) return this._normalizePath((home || '/') + arg.slice(1));
        if (arg.startsWith('~')) return null;  // ~user：无法确定
        if (/^[`$]/.test(arg) || /\$\(|\$\{|\*|\?|`/.test(arg)) return null;
        if (arg.startsWith('/')) return this._normalizePath(arg);
        // 相对路径：拼接到 cwd
        const parts = (cwd || '/').split('/').filter(Boolean);
        for (const seg of arg.split('/')) {
            if (seg === '.' || seg === '') continue;
            if (seg === '..') parts.pop();
            else parts.push(seg);
        }
        return '/' + parts.join('/') || '/';
    },

    /**
     * 解析输入行中的 cd 命令，返回新路径或 null
     */
    _parseCdCommand(line) {
        // 去除前后空格
        line = line.trim();
        // 跳过空行和注释
        if (!line || line.startsWith('#')) return null;
        // 匹配 cd 命令，允许后续跟 && / || / ; / | 等链式操作符
        // 关键：不用 $ 结尾，改为检测后面是否为命令分隔符或字符串末尾
        const m = line.match(/^cd\s+(?:'([^']*)'|"([^"]*)"|([^\s;#&|]*))(?=[\s]*(?:&&|\|\||[;#|&]|$))/);
        if (m) return m[1] || m[2] || m[3] || '';
        // 单独 cd（无参数）：后面直接是分隔符或字符串末尾
        if (/^cd(?=\s*(?:&&|\|\||[;#|&]|$))/.test(line)) return '';
        return null;
    },

    /**
     * 终端目录变化时触发：让正在使用这个连接的 SFTP 面板跟随。
     * 注意：不看 SFTP 标签是否可见 —— 用户在会话标签里 cd、随后切到 SFTP
     * 也必须看到最新目录；面板隐藏时列表在后台刷新即可。
     * 带防抖：快速连续 cd 时只触发最后一次。
     */
    _onTerminalDirChange(connId, newPath) {
        this.cwdMap.set(connId, newPath);

        if (typeof SFTPManager === 'undefined') return;

        // 记录最新目录变化，防抖后统一处理
        this._cdPending = { connId, path: newPath };
        if (this._cdDebounceTimer) clearTimeout(this._cdDebounceTimer);
        this._cdDebounceTimer = setTimeout(() => {
            this._cdDebounceTimer = null;
            const pending = this._cdPending;
            this._cdPending = null;
            if (!pending) return;
            // 只有 SFTP 当前就是这个连接时才跟随（浏览别的连接时不动）
            SFTPManager.onTerminalCwd(pending.connId, pending.path);
        }, 150);
    },

    /**
     * SFTP 里切换了目录 -> 让终端跟随。
     * 用 Ctrl+U 清掉未提交的输入行，避免用户输入的半截命令和 cd 粘在一起。
     */
    applyCwdFromSftp(connId, path) {
        const inst = this.instances.get(connId);
        const target = this._normalizePath(path || '/');
        if (!inst) {
            this.cwdMap.set(connId, target);
            return;
        }
        if (this.cwdMap.get(connId) === target) return;  // 终端已在该目录，无需 cd
        const hadPending = !!inst._inputBuffer;
        inst._inputBuffer = '';
        inst._inputCursor = 0;
        inst._inputUnreliable = false;
        if (hadPending) this._sendInput(connId, '\x15');   // Ctrl+U 清掉未提交的行
        // 注入的 cd 会被 _feedInput 正常解析，cwdMap 由解析器统一更新
        this._sendInput(connId, `cd ${this._quoteRemotePath(target)}\n`);
    },

    /** 远端路径转义：' -> '\'' */
    _quoteRemotePath(p) {
        return "'" + String(p).replace(/'/g, "'\\''") + "'";
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

        // 切窗格/切标签时旧终端的搜索高亮必须收起，否则会留在被切走的那一屏
        if (this.searchState && this.searchState.open) {
            const box = document.getElementById('terminal-search');
            if (box) box.classList.add('hidden');
            this.searchState.open = false;
            this.searchState.hits = [];
            this.searchState.index = -1;
            this._setSearchCount('');
        }

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

        const isSplit = this.splitV || this.splitH;
        if (isSplit) {
            // Make sure the activated terminal occupies a pane
            if (!this.splitPanes.includes(connId)) {
                const maxPanes = (this.splitV && this.splitH) ? 4 : 2;
                while (this.splitPanes.length < maxPanes) {
                    this.splitPanes.push(null);
                }
                let idx = this.splitPanes.indexOf(null);
                if (idx === -1) {
                    const prevIdx = this._prevActive ? this.splitPanes.indexOf(this._prevActive) : -1;
                    idx = prevIdx !== -1 ? prevIdx : 0;
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

        // SFTP 面板正开着时切换终端标签：让它跟随到新终端的当前目录
        if (typeof SFTPManager !== 'undefined' && SFTPManager.currentConnId !== connId) {
            const sftpPanel = document.getElementById('tab-content-sftp');
            if (sftpPanel && sftpPanel.classList.contains('active')) {
                SFTPManager.openForTerminal(connId);
            }
        }
    },

    /**
     * 切换分屏模式。
     * @param {'v'|'h'} mode 'v'=左右分屏, 'h'=上下分屏; 再次点击同一模式则关闭
     */
    setSplitMode(mode) {
        // 切换各自分屏模式
        if (mode === 'v') {
            this.splitV = !this.splitV;
        } else if (mode === 'h') {
            this.splitH = !this.splitH;
        }

        // 计算当前分屏模式
        const isSplitV = this.splitV;
        const isSplitH = this.splitH;
        const isSplit4 = isSplitV && isSplitH;
        const isSplit = isSplitV || isSplitH;

        // 重新构建 splitPanes 数组：按连接顺序排列，第1个在左/上，第2个在右/下
        if (isSplit) {
            const allConnIds = Array.from(this.instances.keys());
            const maxPanes = isSplit4 ? 4 : 2;
            this.splitPanes = allConnIds.slice(0, maxPanes);
            while (this.splitPanes.length < maxPanes) {
                this.splitPanes.push(null);
            }
        } else {
            this.splitPanes = [];
        }

        // Update toggle buttons
        const bv = document.getElementById('btn-split-v');
        const bh = document.getElementById('btn-split-h');
        if (bv) bv.classList.toggle('active', isSplitV);
        if (bh) bh.classList.toggle('active', isSplitH);

        this._applyLayout();
    },

    /** 根据 splitV/splitH/splitPanes 给终端容器和窗格设置布局类并重新 fit */
    _applyLayout() {
        const container = document.getElementById('terminal-container');
        if (!container) return;

        const isSplitV = this.splitV;
        const isSplitH = this.splitH;
        const isSplit4 = isSplitV && isSplitH;
        const isSplit = isSplitV || isSplitH;

        // 四宫格时只保留 split-4，避免 split-v/split-h 的定位规则与 split-4 冲突
        container.classList.toggle('split-v', isSplitV && !isSplit4);
        container.classList.toggle('split-h', isSplitH && !isSplit4);
        container.classList.toggle('split-4', isSplit4);

        // 移除所有窗格类和 active 类
        this.instances.forEach(inst => {
            inst.termDiv.classList.remove('pane-a', 'pane-b', 'pane-c', 'pane-d', 'active');
        });

        if (isSplit) {
            const maxPanes = isSplit4 ? 4 : 2;

            // 清理无效的窗格项，保留 null 作为空位
            this.splitPanes = this.splitPanes
                .map(id => (id && this.instances.has(id) ? id : null))
                .slice(0, maxPanes);
            while (this.splitPanes.length < maxPanes) {
                this.splitPanes.push(null);
            }

            // 把尚未分配的新终端填充到空窗格
            for (const id of this.instances.keys()) {
                if (this.splitPanes.includes(id)) continue;
                const nullIdx = this.splitPanes.indexOf(null);
                if (nullIdx === -1) break;
                this.splitPanes[nullIdx] = id;
            }

            // pane-a: 左上/上, pane-b: 右上/右, pane-c: 左下, pane-d: 右下
            const paneClasses = ['pane-a', 'pane-b', 'pane-c', 'pane-d'];
            this.splitPanes.forEach((connId, idx) => {
                if (connId && this.instances.has(connId)) {
                    const inst = this.instances.get(connId);
                    inst.termDiv.classList.add(paneClasses[idx]);
                    inst.termDiv.classList.add('active');
                }
            });
        } else {
            // 非分屏模式：只显示当前活动终端
            if (this.activeConnId && this.instances.has(this.activeConnId)) {
                this.instances.get(this.activeConnId).termDiv.classList.add('active');
            }
        }
        this.fitVisible();
    },

    /** 对所有可见窗格执行 fit 并把尺寸同步到远端 PTY */
    fitVisible() {
        const container = document.getElementById('terminal-container');
        if (!container) return;
        const isSplit = this.splitV || this.splitH;
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

    /** 终端里写一行状态（重连提示等），失败静默，不能打断输入 */
    _writeStatus(inst, text) {
        try { inst.term && inst.term.write(text); } catch (e) { /* 终端已销毁时忽略 */ }
    },

    /** 标签右键菜单：复制为新标签页 */
    _showTabContextMenu(e, connId) {
        document.querySelectorAll('.context-menu').forEach(el => el.remove());

        const menu = document.createElement('div');
        menu.className = 'context-menu';
        menu.style.left = e.clientX + 'px';
        menu.style.top = e.clientY + 'px';
        menu.innerHTML = `
            <div class="context-menu-item" data-action="duplicate">复制为新标签页</div>
        `;
        document.body.appendChild(menu);

        menu.querySelectorAll('.context-menu-item').forEach(item => {
            item.addEventListener('click', () => {
                if (item.dataset.action === 'duplicate') this.duplicateTab(connId);
                menu.remove();
            });
        });
        // 点菜单外任意处关闭
        setTimeout(() => {
            document.addEventListener('click', () => menu.remove(), { once: true });
        }, 0);
    },

    /** 用同一会话的连接参数再开一个终端标签（新的 SSH 通道，互不影响） */
    async duplicateTab(connId) {
        const inst = this.instances.get(connId);
        if (!inst || !inst.config) return;
        const base = inst.config;
        const cfg = Object.assign({}, base, {
            name: (base.name || base.host || connId) + ' 副本',
        });
        await this.connect(inst.sessionId, cfg);
    },

    /**
     * 无感自动重连：在原终端标签上重新拨号，成功后把断线期间攒下的输入补发。
     * 重连失败不销毁界面，下次输入会再试一次。
     */
    async _reconnect(inst) {
        if (!inst || inst.reconnecting) return;
        if (!inst.config) {
            showToast('连接已断开，缺少重连配置，请重新从会话列表打开', 'error');
            return;
        }
        inst.reconnecting = true;
        inst.closed = false;
        this._setSessionState(inst.sessionId, 'connecting');
        const oldConnId = inst.connId;

        // 旧的 SSE 先关掉，避免两条流往同一个终端写
        if (inst.eventSource) {
            inst.eventSource.close();
            inst.eventSource = null;
        }

        try {
            this._writeStatus(inst, '\r\n\x1b[33m[正在自动重新连接…]\x1b[0m\r\n');
            const res = await fetch('/api/ssh/connect', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(inst.config),
            });
            const result = await res.json();
            if (!result.success) throw new Error(result.error || '连接失败');

            const newConnId = result.conn_id;

            // 旧通道已经是死的：清掉后端残留连接，别留下泄漏的 SSH 通道
            try {
                await fetch('/api/ssh/disconnect', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ conn_id: oldConnId }),
                });
            } catch (e) { /* 旧连接清理失败不影响新连接 */ }

            this._rebindConnId(inst, oldConnId, newConnId);
            // 新通道是全新 shell：清掉旧跟踪目录，让 home 目录重新初始化
            this.cwdMap.delete(newConnId);
            await this._initHomeDir(newConnId);
            this._startSSE(newConnId);
            this.connectedSessions.add(inst.sessionId);
            this._setSessionState(inst.sessionId, 'connected');

            // 补发断线期间攒下的输入（本地输入解析在断线时已经做过一遍，这里只补发到远端）
            const pending = inst.pendingInput || '';
            inst.pendingInput = '';
            inst.reconnecting = false;
            if (pending) this._flushPendingInput(inst, pending);
        } catch (e) {
            inst.reconnecting = false;
            inst.closed = true;
            this._setSessionState(inst.sessionId, 'error');
            showToast('自动重连失败: ' + ((e && e.message) || e), 'error');
        }
    },

    /** 把实例从旧 connId 迁到新 connId（实例表、DOM、目录缓存、分屏引用一起换） */
    _rebindConnId(inst, oldId, newId) {
        this.instances.delete(oldId);
        this.instances.set(newId, inst);
        inst.connId = newId;
        if (inst.termDiv) inst.termDiv.id = 'term-' + newId;
        if (inst.tab) inst.tab.dataset.connId = newId;
        if (this.activeConnId === oldId) this.activeConnId = newId;
        if (this._prevActive === oldId) this._prevActive = newId;

        const moveMap = (m) => {
            if (m.has(oldId)) {
                m.set(newId, m.get(oldId));
                m.delete(oldId);
            }
        };
        moveMap(this.cwdMap);
        moveMap(this.homeMap);
        moveMap(this.prevCwdMap);

        const idx = this.splitPanes.indexOf(oldId);
        if (idx !== -1) this.splitPanes[idx] = newId;
    },

    /** 重连成功后把攒下的输入直接发到新通道，不再走本地输入解析 */
    _flushPendingInput(inst, pending) {
        fetch(`/api/ssh/input/${inst.connId}`, {
            method: 'POST',
            headers: { 'Content-Type': 'text/plain' },
            body: pending,
        }).catch(err => console.error('Flush pending input error:', err));
    },

    async disconnect(connId) {
        const inst = this.instances.get(connId);
        if (!inst) return;

        // Close SSE
        if (inst.eventSource) {
            inst.eventSource.close();
        }

        // Remove from connected sessions only when no other terminal
        // is using the same session (same link can have multiple tabs)
        const stillConnected = Array.from(this.instances.entries())
            .some(([id, other]) => id !== connId && other.sessionId === inst.sessionId);
        if (!stillConnected) {
            this.connectedSessions.delete(inst.sessionId);
            // 用户主动断开：状态归零（灯灭），不是"连接失败"
            this._setSessionState(inst.sessionId, null);
        }

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

        this._outReset(inst);        // 丢掉还没喂给 xterm 的输出，别再往已销毁的终端里写
        inst.term.dispose();
        this.instances.delete(connId);
        this.cwdMap.delete(connId);
        this.homeMap.delete(connId);
        this.prevCwdMap.delete(connId);
        // 通知 SFTP 面板：正在浏览的连接已经断开
        if (typeof SFTPManager !== 'undefined') SFTPManager.onConnectionClosed(connId);
        // 清理防抖状态
        if (this._cdPending && this._cdPending.connId === connId) {
            this._cdPending = null;
            if (this._cdDebounceTimer) {
                clearTimeout(this._cdDebounceTimer);
                this._cdDebounceTimer = null;
            }
        }

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