/**
 * Main Application (app.js)
 * Initializes event handlers and global state.
 */

document.addEventListener('DOMContentLoaded', async () => {
    // Load sessions
    await SessionManager.load();

    // ===== Event Bindings =====

    // New session button
    document.getElementById('btn-new-session').addEventListener('click', () => {
        SessionManager.openNewDialog();
    });

    // Save session
    document.getElementById('btn-save-session').addEventListener('click', () => {
        SessionManager.saveFromForm();
    });

    // Cancel session dialog
    document.getElementById('btn-cancel-session').addEventListener('click', () => {
        document.getElementById('dialog-overlay').classList.add('hidden');
    });

    // Dialog close button
    document.querySelector('.dialog-close').addEventListener('click', () => {
        document.getElementById('dialog-overlay').classList.add('hidden');
    });

    // Close dialog on overlay click
    document.getElementById('dialog-overlay').addEventListener('click', (e) => {
        if (e.target === e.currentTarget) {
            document.getElementById('dialog-overlay').classList.add('hidden');
        }
    });

    // Auth type change
    document.getElementById('form-auth-type').addEventListener('change', (e) => {
        SessionManager._toggleAuthFields(e.target.value);
    });

    // Confirm dialog
    document.getElementById('btn-confirm-yes').addEventListener('click', async () => {
        const sessionId = parseInt(document.getElementById('confirm-overlay').dataset.sessionId);
        if (sessionId) {
            await SessionManager.delete(sessionId);
        }
        document.getElementById('confirm-overlay').classList.add('hidden');
    });

    document.getElementById('btn-confirm-no').addEventListener('click', () => {
        document.getElementById('confirm-overlay').classList.add('hidden');
    });

    document.getElementById('confirm-overlay').addEventListener('click', (e) => {
        if (e.target === e.currentTarget) {
            document.getElementById('confirm-overlay').classList.add('hidden');
        }
    });

    // Host key confirm
    document.getElementById('btn-hostkey-accept').addEventListener('click', () => {
        // Handled in TerminalManager._confirmHostKey
    });

    document.getElementById('btn-hostkey-reject').addEventListener('click', () => {
        document.getElementById('hostkey-overlay').classList.add('hidden');
    });

    document.getElementById('hostkey-overlay').addEventListener('click', (e) => {
        if (e.target === e.currentTarget) {
            document.getElementById('hostkey-overlay').classList.add('hidden');
        }
    });

    // Tab switching (sessions / sftp)
    document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const tab = btn.dataset.tab;
            document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
            document.getElementById('tab-content-' + tab).classList.add('active');

            // If switching to SFTP and there's an active connection, load SFTP
            if (tab === 'sftp' && TerminalManager.activeConnId) {
                // Remember the last directory per connection
                const sameConn = SFTPManager.currentConnId === TerminalManager.activeConnId;
                const path = (sameConn && SFTPManager.currentPath) ? SFTPManager.currentPath : '/';
                SFTPManager.browse(TerminalManager.activeConnId, path);
            }
        });
    });

    // ===== SFTP toolbar =====
    document.getElementById('btn-sftp-upload').addEventListener('click', () => {
        SFTPManager.upload(TerminalManager.activeConnId);
    });

    document.getElementById('btn-sftp-upload-folder').addEventListener('click', () => {
        SFTPManager.uploadFolder(TerminalManager.activeConnId);
    });

    document.getElementById('btn-sftp-mkdir').addEventListener('click', () => {
        SFTPManager.mkdir(TerminalManager.activeConnId);
    });

    document.getElementById('btn-sftp-refresh').addEventListener('click', () => {
        if (TerminalManager.activeConnId) {
            SFTPManager.browse(TerminalManager.activeConnId, SFTPManager.currentPath || '/');
        }
    });

    // 返回上一级
    document.getElementById('btn-sftp-up').addEventListener('click', () => {
        SFTPManager.goUp();
    });

    // 路径输入框：回车跳转，Esc 取消还原，失焦还原为当前目录
    const sftpPathInput = document.getElementById('sftp-path-input');
    sftpPathInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            SFTPManager.goTo(sftpPathInput.value);
            sftpPathInput.blur();
        } else if (e.key === 'Escape') {
            sftpPathInput.value = SFTPManager.currentPath || '/';
            sftpPathInput.blur();
        }
    });
    sftpPathInput.addEventListener('blur', () => {
        sftpPathInput.value = SFTPManager.currentPath || '/';
    });

    // Drag & drop files onto the SFTP list to upload
    SFTPManager._setupDragDrop();

    // ===== File editor =====
    document.getElementById('btn-editor-save').addEventListener('click', () => {
        SFTPManager.saveEditor();
    });
    document.getElementById('btn-editor-close').addEventListener('click', () => {
        SFTPManager.closeEditor();
    });
    document.getElementById('btn-editor-close2').addEventListener('click', () => {
        SFTPManager.closeEditor();
    });

    const editorTa = document.getElementById('editor-textarea');
    editorTa.addEventListener('input', () => {
        SFTPManager._editorDirty = true;
    });
    editorTa.addEventListener('keydown', (e) => {
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
            e.preventDefault();
            SFTPManager.saveEditor();
        } else if (e.key === 'Tab') {
            // Tab inserts a real tab character instead of moving focus
            e.preventDefault();
            const start = editorTa.selectionStart;
            const end = editorTa.selectionEnd;
            editorTa.value = editorTa.value.slice(0, start) + '\t' + editorTa.value.slice(end);
            editorTa.selectionStart = editorTa.selectionEnd = start + 1;
            SFTPManager._editorDirty = true;
        }
    });

    // ===== Split-screen controls =====
    document.getElementById('btn-split-v').addEventListener('click', () => {
        TerminalManager.setSplitMode('v');
    });

    document.getElementById('btn-split-h').addEventListener('click', () => {
        TerminalManager.setSplitMode('h');
    });

    // ===== 全局命令模式 =====
    const btnCmdMode = document.getElementById('btn-cmd-mode');
    const cmdBar = document.getElementById('cmd-bar');
    const cmdInput = document.getElementById('cmd-input');
    const cmdStatus = document.getElementById('cmd-status');
    const cmdHistory = [];
    let cmdHistoryIdx = -1;

    // ===== 命令自动提示 =====
    let cmdSuggestions = [];
    let selectedSuggestionIdx = -1;

    // 创建提示列表容器
    const suggestionPanel = document.createElement('div');
    suggestionPanel.id = 'cmd-suggestions';
    suggestionPanel.style.cssText = 'position:absolute;display:none;z-index:1000;max-height:200px;overflow-y:auto;background:var(--bg);border:1px solid var(--border);border-radius:4px;box-shadow:0 4px 12px rgba(0,0,0,0.3);font-size:12px';
    document.getElementById('cmd-bar').appendChild(suggestionPanel);

    function showSuggestions(items) {
        cmdSuggestions = items;
        selectedSuggestionIdx = -1;
        if (!items || items.length === 0) {
            suggestionPanel.style.display = 'none';
            return;
        }
        suggestionPanel.innerHTML = items.map((item, idx) => `
            <div class="suggestion-item" data-idx="${idx}" style="padding:8px 12px;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-family:monospace"
                 title="${item.command}">
                <span style="color:var(--text-muted)">${item.description || '无描述'}</span>
                <span style="color:var(--accent)">${item.command}</span>
            </div>
        `).join('');
        // 定位到输入框下方
        const rect = cmdInput.getBoundingClientRect();
        suggestionPanel.style.left = rect.left + 'px';
        suggestionPanel.style.top = (rect.bottom + 4) + 'px';
        suggestionPanel.style.width = rect.width + 'px';
        suggestionPanel.style.display = 'block';

        // 鼠标悬停高亮
        suggestionPanel.querySelectorAll('.suggestion-item').forEach(el => {
            el.addEventListener('click', () => {
                const idx = parseInt(el.dataset.idx);
                cmdInput.value = cmdSuggestions[idx].command;
                hideSuggestions();
                cmdInput.focus();
            });
            el.addEventListener('mouseenter', () => {
                suggestionPanel.querySelectorAll('.suggestion-item').forEach(e => e.style.background = '');
                el.style.background = 'var(--highlight)';
            });
        });
    }

    function hideSuggestions() {
        suggestionPanel.style.display = 'none';
        cmdSuggestions = [];
        selectedSuggestionIdx = -1;
    }

    function selectNextSuggestion() {
        if (cmdSuggestions.length === 0) return;
        selectedSuggestionIdx = (selectedSuggestionIdx + 1) % cmdSuggestions.length;
        updateSuggestionHighlight();
    }

    function selectPrevSuggestion() {
        if (cmdSuggestions.length === 0) return;
        selectedSuggestionIdx = (selectedSuggestionIdx - 1 + cmdSuggestions.length) % cmdSuggestions.length;
        updateSuggestionHighlight();
    }

    function updateSuggestionHighlight() {
        suggestionPanel.querySelectorAll('.suggestion-item').forEach((el, idx) => {
            el.style.background = idx === selectedSuggestionIdx ? 'var(--highlight)' : '';
        });
    }

    function applySelectedSuggestion() {
        if (selectedSuggestionIdx >= 0 && selectedSuggestionIdx < cmdSuggestions.length) {
            cmdInput.value = cmdSuggestions[selectedSuggestionIdx].command;
            hideSuggestions();
        }
    }

    // 监听输入
    let suggestionTimer = null;
    cmdInput.addEventListener('input', async () => {
        clearTimeout(suggestionTimer);
        const val = cmdInput.value.trim();
        if (!val) {
            hideSuggestions();
            return;
        }
        // 防抖搜索
        suggestionTimer = setTimeout(async () => {
            const items = await CommandFavorites.search(val);
            showSuggestions(items);
        }, 150);
    });

    // 键盘导航
    cmdInput.addEventListener('keydown', (e) => {
        if (suggestionPanel.style.display !== 'none') {
            if (e.key === 'ArrowDown') {
                e.preventDefault();
                selectNextSuggestion();
            } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                selectPrevSuggestion();
            } else if (e.key === 'Enter') {
                e.preventDefault();
                applySelectedSuggestion();
            } else if (e.key === 'Escape') {
                hideSuggestions();
            } else if (e.key === 'Tab' && cmdSuggestions.length > 0) {
                e.preventDefault();
                applySelectedSuggestion();
            }
        }
    });

    // 失去焦点时隐藏
    cmdInput.addEventListener('blur', () => {
        setTimeout(hideSuggestions, 200);
    });

    // 点击其他地方隐藏
    document.addEventListener('click', (e) => {
        if (!suggestionPanel.contains(e.target) && e.target !== cmdInput) {
            hideSuggestions();
        }
    });

    function showCmdStatus(text) {
        cmdStatus.textContent = text;
        if (text) setTimeout(() => { cmdStatus.textContent = ''; }, 3000);
    }

    function setCmdMode(on) {
        btnCmdMode.classList.toggle('active', on);
        cmdBar.classList.toggle('hidden', !on);
        if (on) {
            cmdInput.focus();
        } else {
            cmdInput.value = '';
            cmdStatus.textContent = '';
        }
        // 命令条显隐改变终端容器高度，重新适配可见窗格
        TerminalManager.fitVisible();
    }

    btnCmdMode.addEventListener('click', () => {
        setCmdMode(!btnCmdMode.classList.contains('active'));
    });

    // ===== 命令队列 =====
    const btnCmdQueue = document.getElementById('btn-cmd-queue');
    const queueBar = document.getElementById('queue-bar');

    function setQueueMode(on) {
        btnCmdQueue.classList.toggle('active', on);
        queueBar.classList.toggle('hidden', !on);
        if (on) setCmdMode(false);  // 队列与全局命令条互斥显示
        TerminalManager.fitVisible();
    }

    btnCmdQueue.addEventListener('click', () => {
        setQueueMode(!btnCmdQueue.classList.contains('active'));
    });
    document.getElementById('btn-queue-start').addEventListener('click', () => {
        CommandQueue.start();
    });
    document.getElementById('btn-queue-stop').addEventListener('click', () => {
        CommandQueue.stop();
    });
    document.getElementById('btn-queue-clear').addEventListener('click', () => {
        CommandQueue.clear();
    });

    // ===== 定时任务 =====
    document.getElementById('btn-tasks').addEventListener('click', () => {
        TaskManager.open();
    });
    document.getElementById('btn-tasks-close').addEventListener('click', () => {
        TaskManager.close();
    });
    document.getElementById('btn-task-save').addEventListener('click', () => {
        TaskManager.save();
    });
    document.getElementById('btn-task-reset').addEventListener('click', () => {
        TaskManager._resetForm();
    });
    document.getElementById('task-schedule-type').addEventListener('change', () => {
        TaskManager._syncScheduleFields();
    });
    TaskManager.bindListEvents();

    // ===== 命令收藏夹 =====
    const favoritesBtn = document.getElementById('btn-favorites');
    const favoritesOverlay = document.getElementById('favorites-overlay');

    function openFavorites() {
        favoritesOverlay.classList.remove('hidden');
        CommandFavorites.load();
    }

    function closeFavorites() {
        favoritesOverlay.classList.add('hidden');
    }

    favoritesBtn.addEventListener('click', openFavorites);
    document.getElementById('btn-favorites-close').addEventListener('click', closeFavorites);
    favoritesOverlay.addEventListener('click', (e) => {
        if (e.target === favoritesOverlay) closeFavorites();
    });

    // 回车添加收藏
    document.getElementById('fav-command').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') CommandFavorites.add();
    });
    document.getElementById('fav-description').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') CommandFavorites.add();
    });
    document.getElementById('btn-add-favorite').addEventListener('click', () => CommandFavorites.add());

    // 排序选择变化时重新加载
    document.getElementById('fav-sort')?.addEventListener('change', () => CommandFavorites.load());

    // ===== 终端快捷键：Ctrl+M 弹出收藏命令 =====
    const terminalFavPanel = document.createElement('div');
    terminalFavPanel.id = 'terminal-fav-panel';
    terminalFavPanel.style.cssText = `
        display:none;
        position:fixed;
        z-index:2000;
        min-width:380px;
        max-width:450px;
        max-height:280px;
        overflow-y:auto;
        background:linear-gradient(145deg, #1e1e2e, #252536);
        border:1px solid #3d3d5c;
        border-radius:12px;
        box-shadow:0 12px 40px rgba(0,0,0,0.6), 0 0 1px rgba(255,255,255,0.1) inset;
        font-size:13px;
        backdrop-filter:blur(10px);
    `;
    document.body.appendChild(terminalFavPanel);

    // 添加标题栏
    const favPanelHeader = document.createElement('div');
    favPanelHeader.style.cssText = 'padding:12px 16px;border-bottom:1px solid #3d3d5c;display:flex;justify-content:space-between;align-items:center';
    favPanelHeader.innerHTML = `
        <span style="color:#fff;font-weight:600;font-size:14px">⭐ 命令收藏</span>
        <span style="color:#666;font-size:11px">↑↓ 选择 · Enter 执行 · Esc 关闭</span>
    `;
    terminalFavPanel.appendChild(favPanelHeader);

    const favPanelBody = document.createElement('div');
    favPanelBody.id = 'fav-panel-body';
    favPanelBody.style.cssText = 'max-height:220px;overflow-y:auto';
    terminalFavPanel.appendChild(favPanelBody);

    let terminalFavItems = [];
    let terminalFavIdx = -1;

    async function showTerminalFavorites(posX, posY) {
        const items = await CommandFavorites.search('');
        terminalFavItems = items;
        terminalFavIdx = -1;

        if (!items || items.length === 0) {
            favPanelBody.innerHTML = '<div style="padding:24px;text-align:center;color:#888">暂无收藏命令<br><small style="color:#666">点击顶部「收藏夹」按钮添加常用命令</small></div>';
            terminalFavPanel.style.display = 'block';
            positionFavPanel(posX, posY);
            return;
        }

        favPanelBody.innerHTML = items.map((item, idx) => `
            <div class="tf-item" data-idx="${idx}" style="
                padding:12px 16px;
                cursor:pointer;
                border-bottom:1px solid #2a2a40;
                display:flex;
                justify-content:space-between;
                align-items:center;
                transition:all 0.15s ease;
            ">
                <div style="flex:1;min-width:0">
                    <div style="font-family:'Consolas','Monaco',monospace;color:#e8e8f0;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-bottom:4px" title="${item.command}">${item.command}</div>
                    <div style="font-size:11px;color:#7a7a8c">${item.description || '无描述'}</div>
                </div>
                <div style="text-align:right;margin-left:12px">
                    <span style="display:inline-block;background:#2a2a45;color:#8b8ba3;padding:2px 8px;border-radius:10px;font-size:10px">${item.use_count}次</span>
                </div>
            </div>
        `).join('');

        // 鼠标悬停高亮
        favPanelBody.querySelectorAll('.tf-item').forEach(el => {
            el.addEventListener('click', async (e) => {
                e.stopPropagation();
                const idx = parseInt(el.dataset.idx);
                await executeFavoriteCommand(terminalFavItems[idx]);
                hideTerminalFavorites();
            });
            el.addEventListener('mouseenter', () => {
                terminalFavIdx = parseInt(el.dataset.idx);
                updateTerminalFavHighlight();
            });
        });

        terminalFavPanel.style.display = 'block';
        positionFavPanel(posX, posY);
    }

    function positionFavPanel(x, y) {
        // 确保弹框不超出屏幕
        const panelWidth = 420;
        const panelHeight = 280;

        let left = x - panelWidth / 2;
        let top = y - panelHeight / 2;

        // 边界检查
        if (left < 10) left = 10;
        if (left + panelWidth > window.innerWidth - 10) left = window.innerWidth - panelWidth - 10;
        if (top < 10) top = 10;
        if (top + panelHeight > window.innerHeight - 10) top = window.innerHeight - panelHeight - 10;

        terminalFavPanel.style.left = left + 'px';
        terminalFavPanel.style.top = top + 'px';
    }

    function hideTerminalFavorites() {
        terminalFavPanel.style.display = 'none';
        terminalFavItems = [];
        terminalFavIdx = -1;
    }

    // 点击其他地方关闭
    document.addEventListener('click', (e) => {
        if (terminalFavPanel.style.display !== 'none' &&
            !terminalFavPanel.contains(e.target) &&
            !e.target.closest('#terminal-container')) {
            hideTerminalFavorites();
        }
    });

    // 阻止弹框内部点击冒泡
    terminalFavPanel.addEventListener('click', (e) => {
        e.stopPropagation();
    });

    function updateTerminalFavHighlight() {
        terminalFavPanel.querySelectorAll('.tf-item').forEach((el, idx) => {
            el.style.background = idx === terminalFavIdx ? 'var(--accent)' : '';
            el.style.color = idx === terminalFavIdx ? '#fff' : '';
        });
        // 确保选中项可见
        if (terminalFavIdx >= 0) {
            const item = terminalFavPanel.querySelector(`.tf-item[data-idx="${terminalFavIdx}"]`);
            if (item) item.scrollIntoView({ block: 'nearest' });
        }
    }

    async function executeFavoriteCommand(favorite) {
        if (!favorite || !TerminalManager.activeConnId) {
            alert('没有活动的终端连接');
            return;
        }
        // 发送命令到终端（通过 API）
        const command = favorite.command + '\n';
        try {
            await fetch(`/api/ssh/input/${TerminalManager.activeConnId}`, {
                method: 'POST',
                headers: { 'Content-Type': 'text/plain' },
                body: command,
            });
        } catch (err) {
            console.error('发送命令失败:', err);
        }
        // 增加使用次数
        await fetch(`/api/command-favorites/${favorite.id}/use`, { method: 'POST' });
    }

    function selectNextFav() {
        if (terminalFavItems.length === 0) return;
        terminalFavIdx = (terminalFavIdx + 1) % terminalFavItems.length;
        updateTerminalFavHighlight();
    }

    function selectPrevFav() {
        if (terminalFavItems.length === 0) return;
        terminalFavIdx = (terminalFavIdx - 1 + terminalFavItems.length) % terminalFavItems.length;
        updateTerminalFavHighlight();
    }

    async function confirmFavSelection() {
        if (terminalFavIdx >= 0 && terminalFavIdx < terminalFavItems.length) {
            await executeFavoriteCommand(terminalFavItems[terminalFavIdx]);
            hideTerminalFavorites();
        }
    }

    // 全局键盘监听 Ctrl+M
    document.addEventListener('keydown', (e) => {
        // Ctrl+M 弹出收藏命令选择器
        if (e.ctrlKey && e.key === 'm' && e.type === 'keydown') {
            // 只有当没有打开其他弹窗时才显示
            const anyOverlay = document.querySelector('.dialog-overlay:not(.hidden)');
            if (!anyOverlay) {
                e.preventDefault();
                // 使用鼠标位置，如果没有则使用屏幕中央
                showTerminalFavorites(e.clientX || window.innerWidth/2, e.clientY || window.innerHeight/2);
            }
        }

        // 当收藏面板显示时的键盘操作
        if (terminalFavPanel.style.display !== 'none') {
            if (e.key === 'ArrowDown' || (e.ctrlKey && e.key === 'ArrowDown')) {
                e.preventDefault();
                selectNextFav();
            } else if (e.key === 'ArrowUp' || (e.ctrlKey && e.key === 'ArrowUp')) {
                e.preventDefault();
                selectPrevFav();
            } else if (e.key === 'Enter') {
                e.preventDefault();
                confirmFavSelection();
            } else if (e.key === 'Escape') {
                e.preventDefault();
                hideTerminalFavorites();
            } else if (e.key === 'Tab') {
                e.preventDefault();
                confirmFavSelection();
            }
        }
    });

    async function runGlobalCmd(text) {
        const t = text.trim();
        if (!t) return;
        if (TerminalManager.instances.size === 0) {
            showCmdStatus('没有已连接的终端');
            return;
        }
        cmdHistory.unshift(t);
        if (cmdHistory.length > 100) cmdHistory.pop();
        cmdHistoryIdx = -1;

        const { ok, total } = await TerminalManager.sendToAllSessions(t + '\n');
        showCmdStatus(`已发送到 ${ok}/${total} 个终端`);
        cmdInput.value = '';
        cmdInput.focus();
    }

    // 监听终端触发的 Ctrl+M 事件（从 xterm 捕获）
    window.addEventListener('show-favorites', (e) => {
        const anyOverlay = document.querySelector('.dialog-overlay:not(.hidden)');
        if (!anyOverlay) {
            // 使用事件传递的位置，或默认到屏幕中央
            const pos = e.detail || {};
            showTerminalFavorites(pos.x || window.innerWidth/2, pos.y || window.innerHeight/2);
        }
    });

    document.getElementById('btn-cmd-send').addEventListener('click', () => {
        runGlobalCmd(cmdInput.value);
    });

    document.getElementById('btn-cmd-ctrlc').addEventListener('click', async () => {
        if (TerminalManager.instances.size === 0) {
            showCmdStatus('没有已连接的终端');
            return;
        }
        const { ok, total } = await TerminalManager.sendToAllSessions('\x03');
        showCmdStatus(`已发送 Ctrl+C 到 ${ok}/${total} 个终端`);
    });

    cmdInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            runGlobalCmd(cmdInput.value);
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            if (cmdHistory.length === 0) return;
            cmdHistoryIdx = Math.min(cmdHistoryIdx + 1, cmdHistory.length - 1);
            cmdInput.value = cmdHistory[cmdHistoryIdx];
        } else if (e.key === 'ArrowDown') {
            e.preventDefault();
            if (cmdHistoryIdx <= 0) {
                cmdHistoryIdx = -1;
                cmdInput.value = '';
            } else {
                cmdHistoryIdx--;
                cmdInput.value = cmdHistory[cmdHistoryIdx];
            }
        } else if (e.key === 'Escape') {
            e.preventDefault();
            setCmdMode(false);
        }
    });

    // Keyboard shortcut: Ctrl+Shift+N for new session
    document.addEventListener('keydown', (e) => {
        if (e.ctrlKey && e.shiftKey && e.key === 'N') {
            e.preventDefault();
            SessionManager.openNewDialog();
        }
    });

    // Keyboard shortcut: Ctrl+Shift+W to close current tab
    document.addEventListener('keydown', (e) => {
        if (e.ctrlKey && e.shiftKey && e.key === 'W') {
            e.preventDefault();
            if (TerminalManager.activeConnId) {
                TerminalManager.disconnect(TerminalManager.activeConnId);
            }
        }
    });

    // ===== 侧边栏宽度拖拽调整 =====
    const SIDEBAR_MIN = 180;
    const SIDEBAR_DEFAULT = 300;
    const resizer = document.getElementById('sidebar-resizer');

    function setSidebarWidth(px) {
        const max = window.innerWidth - 280;   // 主区域至少保留 280px
        const w = Math.round(Math.max(SIDEBAR_MIN, Math.min(px, max)));
        document.documentElement.style.setProperty('--sidebar-w', w + 'px');
        return w;
    }

    // 启动时恢复上次的宽度
    try {
        const saved = parseInt(localStorage.getItem('pyshell.sidebarWidth'), 10);
        if (saved) setSidebarWidth(saved);
    } catch (e) { /* localStorage 不可用时忽略 */ }

    // 拖动中用 rAF 节流重排终端，拖完再同步一次 PTY 尺寸
    let fitPending = false;
    function refitTerminals() {
        if (fitPending) return;
        fitPending = true;
        requestAnimationFrame(() => {
            fitPending = false;
            TerminalManager.fitVisible();
        });
    }

    resizer.addEventListener('mousedown', (e) => {
        e.preventDefault();
        const sidebar = document.getElementById('sidebar');
        const startX = e.clientX;
        const startW = sidebar.getBoundingClientRect().width;
        resizer.classList.add('dragging');
        document.body.classList.add('resizing');

        const onMove = (ev) => {
            setSidebarWidth(startW + (ev.clientX - startX));
            refitTerminals();
        };
        const onUp = () => {
            resizer.classList.remove('dragging');
            document.body.classList.remove('resizing');
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onUp);
            refitTerminals();
            try {
                const w = sidebar.getBoundingClientRect().width;
                localStorage.setItem('pyshell.sidebarWidth', String(Math.round(w)));
            } catch (err) { /* ignore */ }
        };
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
    });

    // 双击恢复默认宽度
    resizer.addEventListener('dblclick', () => {
        setSidebarWidth(SIDEBAR_DEFAULT);
        refitTerminals();
        try { localStorage.removeItem('pyshell.sidebarWidth'); } catch (e) { /* ignore */ }
    });

    // Handle window beforeunload
    window.addEventListener('beforeunload', () => {
        TerminalManager.disconnectAll();
    });

    // Auto-refresh sessions list every 30 seconds
    setInterval(() => {
        SessionManager.load();
    }, 30000);

    // ===== 邮件设置 =====
    async function loadEmailSettings() {
        const res = await fetch('/api/settings');
        const data = await res.json();
        if (data.smtp_server) document.getElementById('smtp-server').value = data.smtp_server;
        if (data.smtp_port) document.getElementById('smtp-port').value = data.smtp_port;
        if (data.smtp_user) document.getElementById('smtp-user').value = data.smtp_user;
        if (data.smtp_pass) document.getElementById('smtp-pass').value = data.smtp_pass;
        if (data.smtp_sender) document.getElementById('smtp-sender').value = data.smtp_sender;
        if (data.smtp_recipients) document.getElementById('smtp-recipients').value = data.smtp_recipients;
        if (data.smtp_enabled) document.getElementById('smtp-enabled').checked = data.smtp_enabled === '1';
    }

    document.getElementById('btn-save-email-settings').addEventListener('click', async () => {
        const settings = {
            smtp_server: document.getElementById('smtp-server').value,
            smtp_port: document.getElementById('smtp-port').value,
            smtp_user: document.getElementById('smtp-user').value,
            smtp_pass: document.getElementById('smtp-pass').value,
            smtp_sender: document.getElementById('smtp-sender').value,
            smtp_recipients: document.getElementById('smtp-recipients').value,
            smtp_enabled: document.getElementById('smtp-enabled').checked ? '1' : '0',
            smtp_use_ssl: document.getElementById('smtp-port').value === '465' ? '1' : '0',
        };
        const res = await fetch('/api/settings', {
            method: 'PUT',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify(settings),
        });
        const result = await res.json();
        document.getElementById('email-status').textContent = result.success ? '✅ 配置已保存' : '❌ 保存失败';
        setTimeout(() => document.getElementById('email-status').textContent = '', 3000);
    });

    document.getElementById('btn-test-email').addEventListener('click', async () => {
        // 先保存再测试
        document.getElementById('btn-save-email-settings').click();
        await new Promise(r => setTimeout(r, 500));
        const res = await fetch('/api/settings/email/test', {method: 'POST'});
        const result = await res.json();
        const status = document.getElementById('email-status');
        if (result.success) {
            status.textContent = '✅ 测试邮件发送成功！请检查接收邮箱';
        } else {
            status.textContent = '❌ 发送失败: ' + (result.error || '未知错误');
        }
    });

    // 切换到设置标签时加载配置
    document.querySelector('[data-tab=settings]').addEventListener('click', loadEmailSettings);

    // ===== 命令收藏夹 =====
    const CommandFavorites = {
        currentSort: 'use_count',
        draggedItem: null,

        async load() {
            const sort = document.getElementById('fav-sort')?.value || 'use_count';
            this.currentSort = sort;
            const res = await fetch(`/api/command-favorites?sort=${sort}`);
            const favorites = await res.json();
            this.render(favorites);
        },

        render(favorites) {
            const container = document.getElementById('favorites-list');
            const countEl = document.getElementById('fav-count');
            if (countEl) countEl.textContent = favorites?.length || 0;

            if (!favorites || favorites.length === 0) {
                container.innerHTML = '<div style="padding:24px;text-align:center;color:var(--text-muted)">暂无收藏命令<br><small style="color:#666">点击顶部「收藏夹」按钮添加常用命令</small></div>';
                return;
            }
            container.innerHTML = favorites.map(f => `
                <div class="favorite-item" data-id="${f.id}" draggable="true" style="padding:10px 12px;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;align-items:center;cursor:grab;transition:background 0.15s" onmouseover="this.style.background='var(--bg-hover)'" onmouseout="this.style.background=''">
                    <div style="display:flex;align-items:center;gap:8px">
                        <span style="color:var(--text-muted);cursor:grab;font-size:14px">☰</span>
                        <div style="flex:1;min-width:0">
                            <div style="font-family:'Consolas','Monaco',monospace;font-size:13px;color:var(--text-highlight);white-space:nowrap;overflow:hidden;text-overflow:ellipsis" title="${f.command}">${f.command}</div>
                            <div style="font-size:11px;color:var(--text-muted);margin-top:2px">${f.description || '无描述'}</div>
                        </div>
                    </div>
                    <div style="display:flex;align-items:center;gap:8px">
                        <span style="background:var(--bg-tertiary);color:var(--text-secondary);padding:2px 8px;border-radius:10px;font-size:10px">${f.use_count}次</span>
                        <button class="btn-delete-fav btn btn-xs" style="padding:4px 8px;border:none;background:transparent;color:var(--text-muted)" title="删除">✕</button>
                    </div>
                </div>
            `).join('');

            // 拖拽排序
            this.initDragAndDrop(container);

            // 删除按钮
            container.querySelectorAll('.btn-delete-fav').forEach(btn => {
                btn.addEventListener('click', async (e) => {
                    e.stopPropagation();
                    const id = e.target.closest('.favorite-item').dataset.id;
                    if (confirm('确定删除这条收藏命令？')) {
                        await fetch(`/api/command-favorites/${id}`, { method: 'DELETE' });
                        this.load();
                    }
                });
            });
        },

        initDragAndDrop(container) {
            const items = container.querySelectorAll('.favorite-item');
            items.forEach(item => {
                item.addEventListener('dragstart', (e) => {
                    this.draggedItem = item;
                    item.style.opacity = '0.5';
                    e.dataTransfer.effectAllowed = 'move';
                });

                item.addEventListener('dragend', () => {
                    item.style.opacity = '1';
                    this.draggedItem = null;
                    items.forEach(i => i.style.background = '');
                });

                item.addEventListener('dragover', (e) => {
                    e.preventDefault();
                    e.dataTransfer.dropEffect = 'move';
                });

                item.addEventListener('dragenter', () => {
                    if (item !== this.draggedItem) {
                        item.style.background = 'var(--bg-hover)';
                    }
                });

                item.addEventListener('dragleave', () => {
                    if (item !== this.draggedItem) {
                        item.style.background = '';
                    }
                });

                item.addEventListener('drop', async (e) => {
                    e.preventDefault();
                    if (item !== this.draggedItem) {
                        const container = item.parentNode;
                        const allItems = [...container.querySelectorAll('.favorite-item')];
                        const draggedIdx = allItems.indexOf(this.draggedItem);
                        const targetIdx = allItems.indexOf(item);

                        if (draggedIdx < targetIdx) {
                            container.insertBefore(this.draggedItem, item.nextSibling);
                        } else {
                            container.insertBefore(this.draggedItem, item);
                        }

                        // 保存新顺序
                        const orderIds = [...container.querySelectorAll('.favorite-item')].map(el => parseInt(el.dataset.id));
                        await fetch('/api/command-favorites/reorder', {
                            method: 'POST',
                            headers: {'Content-Type': 'application/json'},
                            body: JSON.stringify({ order: orderIds }),
                        });

                        // 切换到手动排序模式
                        document.getElementById('fav-sort').value = 'manual';
                        this.currentSort = 'manual';
                    }
                });
            });
        },

        async add() {
            const command = document.getElementById('fav-command').value.trim();
            const description = document.getElementById('fav-description').value.trim();
            if (!command) {
                alert('请输入命令');
                return;
            }
            const res = await fetch('/api/command-favorites', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({ command, description }),
            });
            if (res.ok) {
                document.getElementById('fav-command').value = '';
                document.getElementById('fav-description').value = '';
                this.load();
            }
        },

        async search(query) {
            const res = await fetch(`/api/command-favorites/search?q=${encodeURIComponent(query)}`);
            return await res.json();
        }
    };

    // 暴露给全局，供终端自动提示使用
    window.CommandFavorites = CommandFavorites;
});