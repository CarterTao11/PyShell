/**
 * Smoke test for TerminalManager split-screen logic (no browser needed).
 * Stubs the DOM, xterm.js, EventSource and fetch, then drives
 * connect / activate / setSplitMode / disconnect and asserts pane states.
 *
 * Usage: node tests/test_split_logic.js
 */
const fs = require("fs");
const path = require("path");
const vm = require("vm");

let failures = 0;
function check(name, cond, detail = "") {
    console.log(`[${cond ? "PASS" : "FAIL"}] ${name}` +
        (cond ? "" : ` -- ${detail}`));
    if (!cond) failures++;
}

// ---------------------------------------------------------------- DOM stubs
function makeClassList(el) {
    const s = new Set();
    return {
        add: (...c) => c.forEach(x => s.add(x)),
        remove: (...c) => c.forEach(x => s.delete(x)),
        toggle: (c, force) => {
            if (force === undefined) { s.has(c) ? s.delete(c) : s.add(c); }
            else { force ? s.add(c) : s.delete(c); }
            return s.has(c);
        },
        contains: c => s.has(c),
        _set: s,
    };
}

function makeEl(tag = "div") {
    return {
        tagName: tag, children: [], dataset: {}, style: {},
        _id: null, innerHTML: "", textContent: "",
        set id(v) { this._id = v; }, get id() { return this._id; },
        classList: makeClassList(this),
        appendChild(c) { this.children.push(c); return c; },
        insertBefore(c, ref) {
            const i = ref ? this.children.indexOf(ref) : -1;
            if (i === -1) this.children.push(c); else this.children.splice(i, 0, c);
            return c;
        },
        remove() {},
        addEventListener() {},
    };
}
// classList needs `this` binding fix
function newEl(tag) {
    const el = { tagName: tag || "div", children: [], dataset: {}, style: {},
        innerHTML: "", textContent: "", listeners: {}, _classes: new Set() };
    el.classList = {
        add: (...c) => c.forEach(x => el._classes.add(x)),
        remove: (...c) => c.forEach(x => el._classes.delete(x)),
        toggle: (c, force) => {
            const target = force === undefined ? !el._classes.has(c) : force;
            target ? el._classes.add(c) : el._classes.delete(c);
            return el._classes.has(c);
        },
        contains: c => el._classes.has(c),
    };
    el.appendChild = c => { el.children.push(c); return c; };
    el.insertBefore = (c, ref) => {
        const i = ref ? el.children.indexOf(ref) : -1;
        if (i === -1) el.children.push(c); else el.children.splice(i, 0, c);
        return c;
    };
    el.remove = () => {};
    el.addEventListener = (ev, fn) => { (el.listeners[ev] ||= []).push(fn); };
    return el;
}

const byId = new Map();
function getOrCreate(id) {
    if (!byId.has(id)) byId.set(id, newEl());
    return byId.get(id);
}

const allElements = [];
const doc = {
    createElement: tag => { const e = newEl(tag); allElements.push(e); return e; },
    getElementById: id => {
        // Elements created via createElement are tracked in allElements
        const created = allElements.find(e => e.id === id);
        if (created) return created;
        return getOrCreate(id);
    },
    querySelector: sel => {
        const m = sel.match(/data-conn-id="(.+?)"/);
        if (m) return allElements.find(e => e.dataset.connId === m[1]) || null;
        return null;
    },
    querySelectorAll: () => [],
    addEventListener: () => {},
};
doc.getElementById("terminal-container")._classes.add("pos");

// ---------------------------------------------------------------- stubs
let nextServerConn = 0;
function fakeFetch(url, opts) {
    if (url === "/api/ssh/connect") {
        return Promise.resolve({
            json: async () => ({ success: true, conn_id: "srv" + (++nextServerConn) }),
        });
    }
    return Promise.resolve({ json: async () => ({ success: true }) });
}

function FakeEventSource(url) {
    this.url = url; this.closed = false;
    this.addEventListener = () => {};
    this.close = () => { this.closed = true; };
}

function FakeTerminal(opts) {
    this._opened = false; this._dataHandlers = [];
    this.open = div => { this._opened = true; div._term = this; };
    this.loadAddon = () => {};
    this.onData = fn => this._dataHandlers.push(fn);
    this.attachCustomKeyEventHandler = () => {};
    this.write = () => {}; this.focus = () => {};
    this.hasSelection = () => false; this.dispose = () => {};
}

const sandbox = {
    console,
    document: doc,
    window: { addEventListener: () => {}, removeEventListener: () => {} },
    navigator: {},
    fetch: fakeFetch,
    EventSource: FakeEventSource,
    Terminal: FakeTerminal,
    FitAddon: { FitAddon: function () {
        return { fit() {}, proposeDimensions: () => ({ rows: 30, cols: 100 }) };
    } },
    SessionManager: { render() {} },
    alert: () => {},
    setTimeout: (fn) => 0,          // don't run deferred fits
    Promise, Set, Map, Object, Array, JSON, parseInt, isNaN,
};
sandbox.globalThis = sandbox;

const code = fs.readFileSync(
    path.join(__dirname, "..", "web", "js", "terminal.js"), "utf8") +
    "\n;globalThis.__TM = TerminalManager;";
vm.runInNewContext(code, sandbox);

const TM = sandbox.__TM;

// ---------------------------------------------------------------- tests
(async () => {
    // Connect two terminals (each async connect resolves via fake fetch)
    await TM.connect(101, { name: "srv-A", host: "a" });
    const c1 = TM.activeConnId;
    await TM.connect(102, { name: "srv-B", host: "b" });
    const c2 = TM.activeConnId;

    check("two terminals connected", TM.instances.size === 2, String(TM.instances.size));
    check("latest terminal is active", TM.activeConnId === c2);
    const termDivOf = id => doc.getElementById("term-" + id);
    check("term.open() called on visible container",
        termDivOf(c2)._term && termDivOf(c2)._term._opened);

    // Enable side-by-side split: panes = [active, most recent other]
    TM.setSplitMode("v");
    check("split mode v on", TM.splitMode === "v");
    check("panes filled [c2, c1]", JSON.stringify(TM.splitPanes) === JSON.stringify([c2, c1]),
        JSON.stringify(TM.splitPanes));
    const container = getOrCreate("terminal-container");
    check("container has split-v class", container.classList.contains("split-v"));

    const paneOf = id => {
        const d = doc.getElementById("term-" + id);
        if (d.classList.contains("pane-a")) return "a";
        if (d.classList.contains("pane-b")) return "b";
        return null;
    };
    check("c2 occupies pane-a", paneOf(c2) === "a");
    check("c1 occupies pane-b", paneOf(c1) === "b");

    // New connection while split on: takes the FOCUSED pane (the user was
    // viewing pane-a via c2); the other pane (c1 in pane-b) stays untouched
    await TM.connect(103, { name: "srv-C", host: "c" });
    const c3 = TM.activeConnId;
    check("third terminal active", TM.activeConnId === c3);
    check("c3 took the focused pane-a", paneOf(c3) === "a", paneOf(c3));
    check("c2 (was focused) became tab-only", paneOf(c2) === null, paneOf(c2));
    check("c1 keeps pane-b untouched", paneOf(c1) === "b", paneOf(c1));

    // Clicking the c2 tab swaps it into the focused pane (pane-a),
    // while pane-b (c1) remains stable
    TM.activateTerminal(c2);
    check("activate c2 -> focused pane-a", paneOf(c2) === "a", paneOf(c2));
    check("c1 still in pane-b", paneOf(c1) === "b", paneOf(c1));

    // Focus pane-b by activating c1 (already panned -> no layout change)
    TM.activateTerminal(c1);
    check("activate c1 (already panned) keeps pane-b", paneOf(c1) === "b");

    // Activate tab-only c3 while pane-b is focused: c3 enters pane-b,
    // pane-a (c2) stays put — the fix for panes flipping on tab switches
    TM.activateTerminal(c3);
    check("c3 entered focused pane-b", paneOf(c3) === "b", paneOf(c3));
    check("c2 untouched in pane-a", paneOf(c2) === "a", paneOf(c2));

    // Disconnect the terminal in pane-a (c2) -> freed pane backfilled by
    // the tab-only terminal (c1)
    await TM.disconnect(c2);
    check("after disconnect c2, panes still two",
        TM.splitPanes.filter(Boolean).length === 2, JSON.stringify(TM.splitPanes));
    check("still split mode", TM.splitMode === "v");

    // Disconnect down to one terminal -> split turns off
    await TM.disconnect(c3);
    check("single terminal left -> split off", TM.splitMode === null);
    check("container split-v cleared", !container.classList.contains("split-v"));
    const last = Array.from(TM.instances.keys())[0];
    check("remaining terminal active+visible",
        TM.activeConnId === last &&
        termDivOf(last).classList.contains("active"));

    // Toggle split on with one terminal allowed, then off again
    TM.setSplitMode("h");
    check("split mode h on", TM.splitMode === "h");
    check("container has split-h", container.classList.contains("split-h"));
    TM.setSplitMode("h");
    check("same mode toggles off", TM.splitMode === null);

    console.log();
    if (failures) { console.log(`RESULT: ${failures} FAILED`); process.exit(1); }
    console.log("RESULT: ALL PASSED");
})().catch(e => { console.error(e); process.exit(1); });
