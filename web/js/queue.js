/**
 * Command Queue (queue.js) 命令队列
 *
 * 把多行命令按顺序发送到当前活动终端：每条命令后附加一个唯一的完成
 * 标记（echo PYSHDONE_"<seq>"_ $?），轮询 xterm 缓冲区寻找标记输出行。
 * 输入回显行含有引号（PYSHDONE_"42"），不会误匹配，只有真实输出
 * （PYSHDONE_42_ 0）才算执行完成。
 */
const CommandQueue = {
    running: false,
    items: [],
    idx: 0,
    _seq: 0,          // 全局递增，避免旧标记干扰
    _waiting: null,   // {seq, connId, startedAt}
    _timer: null,
    _pollMs: 250,

    /** 从 textarea 读取命令列表（每行一条，忽略空行和 # 注释） */
    _parseInput() {
        const ta = document.getElementById('queue-input');
        if (!ta) return [];
        return ta.value.split('\n')
            .map(l => l.trim())
            .filter(l => l && !l.startsWith('#'));
    },

    start() {
        if (this.running) return;
        const items = this._parseInput();
        if (items.length === 0) {
            this._status('请先输入命令（每行一条）');
            return;
        }
        if (!TerminalManager.activeConnId ||
            !TerminalManager.instances.has(TerminalManager.activeConnId)) {
            this._status('没有活动终端，请先连接');
            return;
        }
        this.items = items;
        this.idx = 0;
        this.running = true;
        this._step();
    },

    stop() {
        if (!this.running) return;
        this.running = false;
        this._waiting = null;
        if (this._timer) { clearInterval(this._timer); this._timer = null; }
        this._status(`已停止（完成 ${this.idx}/${this.items.length} 条）`);
    },

    clear() {
        if (this.running) this.stop();
        const ta = document.getElementById('queue-input');
        if (ta) ta.value = '';
        this._status('');
    },

    _status(text) {
        const el = document.getElementById('queue-status');
        if (el) el.textContent = text;
    },

    _step() {
        if (!this.running) return;
        if (this.idx >= this.items.length) {
            this.running = false;
            this._waiting = null;
            if (this._timer) { clearInterval(this._timer); this._timer = null; }
            this._status(`✓ 队列执行完成（共 ${this.items.length} 条）`);
            return;
        }

        const connId = TerminalManager.activeConnId;
        if (!connId || !TerminalManager.instances.has(connId)) {
            this.running = false;
            this._status(`✗ 终端已断开，队列中止（完成 ${this.idx}/${this.items.length} 条）`);
            return;
        }

        const cmd = this.items[this.idx];
        const seq = ++this._seq;
        this._waiting = { seq, connId };
        this._status(`执行 ${this.idx + 1}/${this.items.length}: ${cmd}`);

        // 标记命令：输入回显里是 PYSHDONE_"<seq>"_ $?（带引号），
        // 真实输出才是 PYSHDONE_<seq>_ <rc> —— 用引号避开回显误判
        TerminalManager._sendInput(connId,
            `${cmd}; echo PYSHDONE_"${seq}"_ $?\r`);

        if (this._timer) clearInterval(this._timer);
        this._timer = setInterval(() => this._checkDone(), this._pollMs);
    },

    _checkDone() {
        if (!this.running || !this._waiting) return;
        const { seq, connId } = this._waiting;
        const inst = TerminalManager.instances.get(connId);
        if (!inst) {
            this.running = false;
            this._waiting = null;
            if (this._timer) { clearInterval(this._timer); this._timer = null; }
            this._status(`✗ 终端已断开，队列中止（完成 ${this.idx}/${this.items.length} 条）`);
            return;
        }

        const found = this._scanBuffer(inst, seq);
        if (found === null) return;  // 还没完成

        const exitCode = found;
        this._waiting = null;
        if (this._timer) { clearInterval(this._timer); this._timer = null; }
        this.idx++;
        const prefix = exitCode === 0 ? '' : `⚠ 上一条退出码 ${exitCode}，`;
        this._status(`${prefix}完成 ${this.idx}/${this.items.length}`);
        // 稍作停顿再执行下一条，给 shell 一点喘息
        setTimeout(() => this._step(), 200);
    },

    /**
     * 扫描终端缓冲区尾部，寻找当前 seq 的完成标记。
     * 返回退出码数字；未找到返回 null。
     */
    _scanBuffer(inst, seq) {
        try {
            const buf = inst.term.buffer.active;
            const total = buf.length;
            const from = Math.max(0, total - 150);
            const re = new RegExp(`PYSHDONE_${seq}_\\s*(\\d+)`);
            for (let i = total - 1; i >= from; i--) {
                const line = buf.getLine(i);
                if (!line) continue;
                const m = line.translateToString(true).match(re);
                if (m) return parseInt(m[1], 10);
            }
        } catch (e) {
            console.warn('queue scan error:', e);
        }
        return null;
    },

    /** 测试辅助：给定文本行，解析标记（不依赖 xterm） */
    _parseDoneText(text, seq) {
        const re = new RegExp(`PYSHDONE_${seq}_\\s*(\\d+)`);
        const m = String(text).match(re);
        return m ? parseInt(m[1], 10) : null;
    },
};
