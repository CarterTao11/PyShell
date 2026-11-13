/**
 * 命令模板（template.js）
 * 收藏的命令里用 {{变量}} 占位，执行时逐个填值：
 *     docker logs {{container}} --tail {{lines}}
 *   ->  填写 container=web-1、lines=200  ->  发送 docker logs web-1 --tail 200
 *
 * 设计取舍：
 *   - 只做"{变量 → 值}"的纯文本替换，不做表达式、默认值语法（写多了没人记得住）
 *   - 变量名允许中文（{{容器名}}），不允许空格和花括号
 *   - 填过的值按 收藏 id + 变量名 记在 localStorage，下次点同一条模板直接回车沿用
 */
const CommandTemplate = {
    VAR_RE: /\{\{\s*([^\s{}]{1,32})\s*\}\}/g,

    /** 按出现顺序去重提取变量名 */
    varsOf(command) {
        const out = [];
        const seen = new Set();
        String(command || '').replace(this.VAR_RE, (m, name) => {
            if (!seen.has(name)) { seen.add(name); out.push(name); }
            return m;
        });
        return out;
    },

    isTemplate(command) {
        return this.varsOf(command).length > 0;
    },

    _key(id, name) {
        return 'pyshell.tpl.' + id + '.' + name;
    },

    /** 上次填的值：同一条模板重复执行时不用重复敲 */
    remembered(id, name) {
        try { return localStorage.getItem(this._key(id, name)) || ''; } catch (e) { return ''; }
    },

    remember(id, name, value) {
        try { localStorage.setItem(this._key(id, name), value); } catch (e) { /* 隐私模式忽略 */ }
    },

    /** 逐个弹自绘输入框填参数；任一取消返回 null（整条命令都不发） */
    async fill(favorite) {
        const vars = this.varsOf(favorite.command);
        const values = {};
        for (let i = 0; i < vars.length; i++) {
            const name = vars[i];
            const v = await Dialog.prompt({
                title: `填写命令参数（${i + 1}/${vars.length}）`,
                label: `{{${name}}}`,
                message: favorite.command,
                value: this.remembered(favorite.id, name),
                okText: i === vars.length - 1 ? '执行' : '下一步',
            });
            if (v === null || v === undefined) return null;
            if (!String(v).trim()) {
                showToast(`参数 {{${name}}} 不能为空，已取消`, 'warning');
                return null;
            }
            values[name] = String(v);
            this.remember(favorite.id, name, values[name]);
        }
        return values;
    },

    /** 把 {{var}} 换成值；没给值的保持原样（方便看出哪一截没填） */
    apply(command, values) {
        return String(command).replace(this.VAR_RE, (m, name) =>
            (values && values[name] !== undefined) ? values[name] : m);
    },
};
