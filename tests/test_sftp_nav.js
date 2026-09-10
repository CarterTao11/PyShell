/**
 * Smoke test for SFTPManager navigation logic (no browser needed):
 * normalizePath / _parentOf / goUp / goTo / browse commit-on-success.
 *
 * Usage: node tests/test_sftp_nav.js
 */
const fs = require("fs");
const path = require("path");
const vm = require("vm");

let failures = 0;
function check(name, cond, detail = "") {
    console.log(`[${cond ? "PASS" : "FAIL"}] ${name}` + (cond ? "" : ` -- ${detail}`));
    if (!cond) failures++;
}

function makeEl() {
    const el = {
        style: {}, value: "", innerHTML: "", dataset: {}, _classes: new Set(),
    };
    el.classList = {
        add: (...c) => c.forEach(x => el._classes.add(x)),
        remove: (...c) => c.forEach(x => el._classes.delete(x)),
        toggle: (c, f) => { (f === undefined ? !el._classes.has(c) : f) ? el._classes.add(c) : el._classes.delete(c); },
        contains: c => el._classes.has(c),
    };
    el.addEventListener = () => {};
    el.querySelectorAll = () => [];
    return el;
}

const els = {
    "sftp-path-input": makeEl(),
    "sftp-browser": makeEl(),
    "sftp-file-list": makeEl(),
    "sftp-status": makeEl(),
};

let fetchCalls = [];       // recorded /api/sftp/list URLs
let listResult = { success: true, items: [] };  // canned list response

const sandbox = {
    console,
    alert: () => {},
    fetch: (url) => {
        fetchCalls.push(url);
        return Promise.resolve({ json: async () => listResult });
    },
    document: {
        getElementById: id => els[id] || null,
        querySelector: () => ({ style: {} }),
        createElement: () => makeEl(),
        addEventListener: () => {},
    },
    setTimeout: () => 0,
    Promise, Object, Array, String, Date, JSON, parseInt, isNaN, encodeURIComponent,
};
sandbox.globalThis = sandbox;

const code = fs.readFileSync(
    path.join(__dirname, "..", "web", "js", "sftp.js"), "utf8") +
    "\n;globalThis.__SM = SFTPManager;";
vm.runInNewContext(code, sandbox);

const SM = sandbox.__SM;

(async () => {
    // ---- normalizePath
    check("normalize keeps /", SM.normalizePath("/") === "/");
    check("normalize strips trailing slash", SM.normalizePath("/usr/local/") === "/usr/local",
        SM.normalizePath("/usr/local/"));
    check("normalize adds leading slash", SM.normalizePath("var/log") === "/var/log",
        SM.normalizePath("var/log"));
    check("normalize collapses double slashes", SM.normalizePath("//a//b//") === "/a/b",
        SM.normalizePath("//a//b//"));
    check("normalize backslashes", SM.normalizePath("\\a\\b") === "/a/b",
        SM.normalizePath("\\a\\b"));
    check("normalize empty -> /", SM.normalizePath("") === "/");
    check("normalize root with slashes -> /", SM.normalizePath("///") === "/");

    // ---- _parentOf
    check("parent of /usr/local -> /usr", SM._parentOf("/usr/local") === "/usr");
    check("parent of /usr -> /", SM._parentOf("/usr") === "/");
    check("parent of / -> /", SM._parentOf("/") === "/");
    check("parent of /usr/local/ -> /usr", SM._parentOf("/usr/local/") === "/usr");

    // ---- browse success commits the path
    els["sftp-file-list"].innerHTML = "old";
    await SM.browse("conn1", "/usr/local/");
    check("browse normalizes + commits path", SM.currentPath === "/usr/local",
        SM.currentPath);
    check("browse fetches normalized path",
        fetchCalls[fetchCalls.length - 1].endsWith(encodeURIComponent("/usr/local")),
        fetchCalls[fetchCalls.length - 1]);
    check("path input shows current dir", els["sftp-path-input"].value === "/usr/local",
        els["sftp-path-input"].value);
    check("file list rendered", els["sftp-file-list"].innerHTML !== "old");

    // ---- browse failure keeps previous good path
    listResult = { success: false, error: "no such file" };
    await SM.browse("conn1", "/does/not/exist");
    check("failed browse keeps previous path", SM.currentPath === "/usr/local",
        SM.currentPath);
    check("failed browse restores path input", els["sftp-path-input"].value === "/usr/local",
        els["sftp-path-input"].value);

    // ---- goUp
    listResult = { success: true, items: [] };
    SM.goUp();
    await new Promise(r => setTimeout(r, 0));
    check("goUp /usr/local -> /usr", SM.currentPath === "/usr", SM.currentPath);
    SM.goUp();
    await new Promise(r => setTimeout(r, 0));
    check("goUp /usr -> /", SM.currentPath === "/", SM.currentPath);
    const callsAtRoot = fetchCalls.length;
    SM.goUp();
    await new Promise(r => setTimeout(r, 0));
    check("goUp at root does nothing", fetchCalls.length === callsAtRoot);

    // ---- goTo via input (relative path normalized)
    await SM.goTo("var/log");
    await new Promise(r => setTimeout(r, 0));
    check("goTo normalizes to absolute", SM.currentPath === "/var/log", SM.currentPath);
    await SM.goTo("   ");
    check("goTo ignores blank input", SM.currentPath === "/var/log");

    // ---- directory-first sorting
    SM.currentPath = "/";   // no ".." row -> only sorted items in html
    SM._renderFiles([
        { name: "zFile.txt", is_dir: false, size: 1 },
        { name: "b Dir", is_dir: true, size: 0 },
        { name: "file10.txt", is_dir: false, size: 1 },
        { name: "A Dir", is_dir: true, size: 0 },
        { name: "file2.txt", is_dir: false, size: 1 },
        { name: "数据集", is_dir: true, size: 0 },
    ]);
    const order = [...els["sftp-file-list"].innerHTML.matchAll(/data-path="([^"]+)"/g)]
        .map(m => m[1]);
    check("dirs listed before files",
        JSON.stringify(order.slice(0, 3)) === JSON.stringify(["A Dir", "b Dir", "数据集"]),
        JSON.stringify(order));
    check("files sorted naturally (file2 < file10, case-insensitive)",
        JSON.stringify(order.slice(3)) === JSON.stringify(["file2.txt", "file10.txt", "zFile.txt"]),
        JSON.stringify(order.slice(3)));

    // ---- _planUploads: folder upload path planning
    const f = name => ({ name });
    const p1 = SM._planUploads("/", [
        { relPath: "a.txt", file: f("a.txt") },
        { relPath: "mydir/sub/f1.txt", file: f("f1.txt") },
        { relPath: "mydir/f2.txt", file: f("f2.txt") },
        { relPath: "mydir/sub/deep/f3.txt", file: f("f3.txt") },
    ]);
    check("file at root targets root", p1.planned[0].targetDir === "/", p1.planned[0].targetDir);
    check("nested file targets nested dir",
        p1.planned[1].targetDir === "/mydir/sub", p1.planned[1].targetDir);
    check("dirs set has all unique target dirs",
        JSON.stringify([...p1.dirs].sort()) ===
        JSON.stringify(["/mydir", "/mydir/sub", "/mydir/sub/deep"]),
        JSON.stringify([...p1.dirs]));

    const p2 = SM._planUploads("/srv/data", [
        { relPath: "mydir/sub/f1.txt", file: f("f1.txt") },
    ]);
    check("relative paths anchored at currentPath",
        p2.planned[0].targetDir === "/srv/data/mydir/sub", p2.planned[0].targetDir);
    check("no dirs collected when everything is in currentPath",
        SM._planUploads("/", [{ relPath: "a.txt", file: f("a.txt") }]).dirs.size === 0);

    // backslashes normalized
    const p3 = SM._planUploads("/", [{ relPath: "win\\dir\\f.txt", file: f("f.txt") }]);
    check("backslash paths normalized", p3.planned[0].targetDir === "/win/dir",
        p3.planned[0].targetDir);

    console.log();
    if (failures) { console.log(`RESULT: ${failures} FAILED`); process.exit(1); }
    console.log("RESULT: ALL PASSED");
    process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
