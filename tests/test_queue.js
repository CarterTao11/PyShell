/**
 * Unit tests for CommandQueue marker parsing (no browser/xterm needed).
 * Usage: node tests/test_queue.js
 */
const fs = require("fs");
const path = require("path");
const vm = require("vm");

let failures = 0;
function check(name, cond, detail = "") {
    console.log(`[${cond ? "PASS" : "FAIL"}] ${name}` + (cond ? "" : ` -- ${detail}`));
    if (!cond) failures++;
}

const sandbox = {
    console, document: {
        getElementById: () => null,
        createElement: () => ({ addEventListener() {}, style: {} }),
        querySelectorAll: () => [],
        addEventListener: () => {},
    },
    setTimeout: () => 0, setInterval: () => 0, clearInterval: () => {},
    Promise, Object, Array, String, Math, parseInt, RegExp,
};
sandbox.globalThis = sandbox;

const code = fs.readFileSync(
    path.join(__dirname, "..", "web", "js", "queue.js"), "utf8") +
    "\n;globalThis.__CQ = CommandQueue;";
vm.runInNewContext(code, sandbox);

const CQ = sandbox.__CQ;

// Real output line: echo expands quotes -> concatenated marker + exit code
check("real output matched (rc 0)",
      CQ._parseDoneText('PYSHDONE_7_ 0', 7) === 0);
check("real output matched (rc 1)",
      CQ._parseDoneText('PYSHDONE_42_ 1', 42) === 1);
check("real output matched (rc 127)",
      CQ._parseDoneText('PYSHDONE_42_ 127', 42) === 127);

// Input echo contains quotes between marker parts -> must NOT match
check("input echo NOT matched", CQ._parseDoneText('echo PYSHDONE_"42"_ $?', 42) === null);
check("other seq NOT matched", CQ._parseDoneText('PYSHDONE_7_ 0', 42) === null);
check("no marker -> null", CQ._parseDoneText('some random output', 42) === null);

// Marker buried among other output lines still found
const buf = [
    'user@host:~$ ./deploy.sh',
    'uploading...',
    'PYSHDONE_9_ 0',
].join("\n");
check("found among output lines", CQ._parseDoneText(buf, 9) === 0);

// Multi-line buffer where marker in middle
check("marker mid-buffer", CQ._parseDoneText('a\nPYSHDONE_3_ 2\nb', 3) === 2);

console.log();
if (failures) { console.log(`RESULT: ${failures} FAILED`); process.exit(1); }
console.log("RESULT: ALL PASSED");
