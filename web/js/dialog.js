/**
 * 统一弹框（替代浏览器原生 alert / confirm / prompt）
 *
 * 原生弹框在桌面端有三个硬伤：阻塞主线程、样式无法定制、Electron/浏览器里标题会带
 * 站点名，且关不掉。这里用项目里已有的 .dialog / .dialog-overlay 样式自绘，行为对齐
 * 原生语义：
 *
 *   await Dialog.alert('只有确定');                          -> 无返回值
 *   if (await Dialog.confirm('确定删除？')) { ... }          -> true / false
 *   const name = await Dialog.prompt({ title, label, value }) -> string / null（取消）
 *
 * 交互约定：
 *   - 回车 = 确定，Esc = 取消（prompt 回车提交输入框内容）
 *   - 点遮罩 = 取消（不会误触发危险操作）
 *   - 同一时刻只允许一个弹框；再次打开会把上一个按"取消"结算，不会挂死 Promise
 *   - 关闭后焦点回到打开前的元素（例如编辑器的文本域）
 */
(function (global) {
    'use strict';

    /**
     * 统一入口参数：既可以 Dialog.confirm('问题')，也可以
     * Dialog.confirm('问题', { message: '补充说明' })——两段会分行显示；
     * 否则 opts 里的 message 会把问题本身顶掉（只剩"不可恢复"看不到问的是什么）。
     */
    function mergeMessage(arg, opts) {
        const o = Object.assign({}, opts || {});
        if (typeof arg === 'string') {
            o.message = o.message ? (arg + '\n\n' + o.message) : arg;
        } else if (arg && typeof arg === 'object') {
            Object.assign(o, arg);
        }
        return o;
    }

    const Dialog = {
        _overlay: null,
        _els: null,
        _active: null,        // { resolve, prevFocus, kind }
        _kind: 'alert',
        _onKeyBound: null,

        /** 懒创建 DOM：弹框不进入 index.html，避免和编辑器等弹框互相干扰 */
        _build() {
            if (this._overlay) return;

            const overlay = document.createElement('div');
            overlay.className = 'dialog-overlay app-dialog-overlay hidden';
            overlay.setAttribute('role', 'dialog');
            overlay.setAttribute('aria-modal', 'true');

            const dlg = document.createElement('div');
            dlg.className = 'dialog dialog-sm app-dialog';

            const header = document.createElement('div');
            header.className = 'dialog-header';
            const title = document.createElement('h3');
            title.className = 'app-dialog-title';
            title.textContent = '提示';
            const closeX = document.createElement('button');
            closeX.className = 'dialog-close app-dialog-x';
            closeX.type = 'button';
            closeX.title = '关闭';
            closeX.textContent = '×';
            header.appendChild(title);
            header.appendChild(closeX);

            const body = document.createElement('div');
            body.className = 'dialog-body';
            const message = document.createElement('div');
            message.className = 'app-dialog-message';
            const label = document.createElement('label');
            label.className = 'app-dialog-label';
            const input = document.createElement('input');
            input.className = 'app-dialog-input';
            input.type = 'text';
            input.spellcheck = false;
            body.appendChild(message);
            body.appendChild(label);
            body.appendChild(input);

            const footer = document.createElement('div');
            footer.className = 'dialog-footer';
            const cancelBtn = document.createElement('button');
            cancelBtn.className = 'btn app-dialog-cancel';
            cancelBtn.type = 'button';
            cancelBtn.textContent = '取消';
            const okBtn = document.createElement('button');
            okBtn.className = 'btn btn-primary app-dialog-ok';
            okBtn.type = 'button';
            okBtn.textContent = '确定';
            footer.appendChild(cancelBtn);
            footer.appendChild(okBtn);

            dlg.appendChild(header);
            dlg.appendChild(body);
            dlg.appendChild(footer);
            overlay.appendChild(dlg);
            document.body.appendChild(overlay);

            this._overlay = overlay;
            this._els = { dlg, title, message, label, input, cancelBtn, okBtn, closeX };

            closeX.addEventListener('click', () => this._close(false));
            cancelBtn.addEventListener('click', () => this._close(false));
            okBtn.addEventListener('click', () => this._confirm());
            // 点遮罩空白处 = 取消；点对话框内部不触发
            overlay.addEventListener('mousedown', (e) => {
                if (e.target === overlay) this._close(false);
            });
            input.addEventListener('keydown', (e) => this._onKey(e));
            this._onKeyBound = (e) => this._onKey(e);
            overlay.addEventListener('keydown', this._onKeyBound);
        },

        _onKey(e) {
            if (!this._active) return;
            const els = this._els;
            if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                this._close(false);
            } else if (e.key === 'Enter') {
                // 焦点在"取消"/"×"上时交给按钮自己的 click（否则回车会变成确定）
                if (e.target === els.cancelBtn || e.target === els.closeX) return;
                e.preventDefault();
                e.stopPropagation();
                this._confirm();
            }
        },

        /** 确定：prompt 取输入框内容，其余返回 true */
        _confirm() {
            const value = this._kind === 'prompt' ? this._els.input.value : true;
            this._close(value);
        },

        _open(kind, opts) {
            this._build();
            // 上一个弹框还没结算就再开一个：先按取消收尾，避免 Promise 永远挂着
            if (this._active) this._close(false);

            const els = this._els;
            const o = opts || {};
            this._kind = kind;

            els.title.textContent = o.title || (kind === 'prompt' ? '请输入' : kind === 'confirm' ? '请确认' : '提示');
            els.message.textContent = o.message || '';
            els.message.style.display = o.message ? '' : 'none';

            const hasInput = kind === 'prompt';
            els.label.textContent = hasInput ? (o.label || '') : '';
            els.label.style.display = hasInput && o.label ? '' : 'none';
            els.input.style.display = hasInput ? '' : 'none';
            els.input.value = hasInput ? (o.value == null ? '' : String(o.value)) : '';
            els.input.placeholder = o.placeholder || '';

            els.cancelBtn.style.display = kind === 'alert' ? 'none' : '';
            els.cancelBtn.textContent = o.cancelText || '取消';
            els.okBtn.textContent = o.okText || (kind === 'alert' ? '知道了' : '确定');
            els.okBtn.className = 'btn app-dialog-ok ' + (o.danger ? 'btn-danger' : 'btn-primary');
            // alert 只有"确定"一个出口，不显示右上角 ×
            els.closeX.style.display = kind === 'alert' ? 'none' : '';

            this._overlay.classList.remove('hidden');

            const prevFocus = document.activeElement;
            this._active = { resolve: null, prevFocus, kind };

            return new Promise((resolve) => {
                this._active.resolve = resolve;
                // 焦点进弹框：prompt 选中默认值（直接打字即覆盖），其余落在确定按钮
                setTimeout(() => {
                    try {
                        if (hasInput) {
                            els.input.focus();
                            els.input.select && els.input.select();
                        } else {
                            els.okBtn.focus();
                        }
                    } catch (e) { /* 忽略焦点异常 */ }
                }, 0);
            });
        },

        _close(raw) {
            const active = this._active;
            if (!active) return;
            this._active = null;

            this._overlay.classList.add('hidden');

            const prev = active.prevFocus;
            if (prev && typeof prev.focus === 'function') {
                try { prev.focus(); } catch (e) { /* 目标元素可能已被移除 */ }
            }

            const cancelled = raw === false;
            let value;
            if (active.kind === 'prompt') value = cancelled ? null : String(raw);
            else if (active.kind === 'confirm') value = !cancelled;
            else value = undefined;

            active.resolve(value);
        },

        /** 是否正在显示 */
        isOpen() {
            return !!(this._overlay && this._active);
        },

        /** 提示信息，只有一个按钮 */
        alert(message, opts) {
            return this._open('alert', mergeMessage(message, opts));
        },

        /** 确认框，返回 true / false */
        confirm(message, opts) {
            return this._open('confirm', mergeMessage(message, opts));
        },

        /** 输入框，返回输入内容 / null（取消） */
        prompt(opts, defaultValue) {
            const o = typeof opts === 'string' ? mergeMessage(opts, { value: defaultValue }) : mergeMessage(opts);
            return this._open('prompt', o);
        },
    };

    global.Dialog = Dialog;
})(typeof window !== 'undefined' ? window : globalThis);
