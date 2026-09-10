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

    // Handle window beforeunload
    window.addEventListener('beforeunload', () => {
        TerminalManager.disconnectAll();
    });

    // Auto-refresh sessions list every 30 seconds
    setInterval(() => {
        SessionManager.load();
    }, 30000);
});