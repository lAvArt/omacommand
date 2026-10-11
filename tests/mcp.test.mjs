// Spec 11, test 12: the MCP server. These tests start the real mcp/server.rb with Ruby, and a fake omarchy-shell that is
// put first on PATH. When Ruby is not installed they are skipped with a message. The fake needs a POSIX shell, so the cases
// that use it are skipped on Windows. No setting of the server changes for the tests: it is the production file, run as is.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { ROOT } from "./helpers.mjs";

const SERVER = path.join(ROOT, "mcp", "server.rb");
const TARGET = "io.github.lavart.omacommand";

function findRuby() {
  const r = spawnSync("ruby", ["-e", "print RbConfig.ruby"], { encoding: "utf8" });
  if (r.error || r.status !== 0 || !r.stdout) return null;
  return r.stdout.trim();
}

const RUBY = findRuby();
const NO_RUBY = RUBY ? false : "ruby not found: run on a machine with Ruby 3.4";
const NO_POSIX = process.platform === "win32" ? "needs a POSIX shell to fake omarchy-shell: skipped on Windows" : false;
const skipRuby = NO_RUBY;
const skipFake = NO_RUBY || NO_POSIX;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------- a fake omarchy-shell
// The mode file in its folder says how it behaves. Every call is written to calls.log, the proposal to propose.json.
const FAKE = `#!/bin/sh
dir="$(dirname "$0")"
mode="$(cat "$dir/mode" 2>/dev/null || echo ok)"
printf '%s\\n' "$*" >> "$dir/calls.log"
if [ "$mode" = "hung" ]; then
  echo $$ > "$dir/pid"
  exec sleep 30
fi
if [ "$mode" = "not_running" ]; then echo "omarchy-shell is not running" >&2; exit 1; fi
if [ "$mode" = "not_enabled" ]; then echo "Target not found." >&2; exit 1; fi
if [ "$mode" = "not_responding" ] && [ "$2" = "propose" ]; then echo "omarchy-shell is not responding" >&2; exit 1; fi
if [ "$mode" = "status_fails" ] && [ "$2" = "status" ]; then echo "omarchy-shell is not responding" >&2; exit 1; fi
if [ "$mode" = "needs_path" ] && [ -z "$OMARCHY_PATH" ]; then echo "OMARCHY_PATH is not set" >&2; exit 1; fi
if [ "$1" != "${TARGET}" ]; then echo "Target not found." >&2; exit 1; fi
n=0
case "$2" in
  ping) echo '{"v":1,"name":"omacommand","version":"1.0.0","ready":true}' ;;
  propose)
    printf '%s' "$3" > "$dir/propose.json"
    id="$(printf '%s' "$3" | grep -o '"id":"[0-9a-f]\\{32\\}"' | head -n 1 | cut -d'"' -f4)"
    if [ "$mode" = "refuse" ]; then
      echo '{"v":1,"ok":false,"state":"refused","message":"Step 1: that app is not on Omacommand'"'"'s list."}'
    else
      printf '{"v":1,"ok":true,"id":"%s"}\\n' "$id"
    fi ;;
  status)
    n="$(cat "$dir/n" 2>/dev/null || echo 0)"; n=$((n + 1)); echo "$n" > "$dir/n"
    case "$mode" in
      restart_waiting) if [ "$n" -lt 2 ]; then s=pending; else s=unknown; fi ;;
      restart_running) if [ "$n" -lt 2 ]; then s=running; else s=unknown; fi ;;
      not_responding) s=unknown ;;
      denied) s=denied ;;
      failed) s=failed ;;
      slow) s=pending ;;
      *) if [ "$n" -lt 2 ]; then s=pending; else s=done; fi ;;
    esac
    case "$s" in
      pending) printf '{"v":1,"id":"%s","state":"pending","message":"Waiting for the person to answer.","steps":[]}\\n' "$3" ;;
      running) printf '{"v":1,"id":"%s","state":"running","message":"The steps are running.","steps":[]}\\n' "$3" ;;
      unknown) printf '{"v":1,"id":"%s","state":"unknown","message":"Omacommand has no record of that request.","steps":[]}\\n' "$3" ;;
      denied) printf '{"v":1,"id":"%s","state":"denied","message":"The person said no. Nothing ran.","steps":[]}\\n' "$3" ;;
      failed) printf '{"v":1,"id":"%s","state":"failed","message":"Step 2 failed: Spotify is not open. The steps after it did not run.","steps":[{"ok":true,"note":"Go to workspace 2: done"},{"ok":false,"note":"Focus the Spotify window: failed (Spotify is not open)"}]}\\n' "$3" ;;
      *) printf '{"v":1,"id":"%s","state":"done","message":"The person allowed it. All 2 steps ran.","steps":[{"ok":true,"note":"Go to workspace 2: done"},{"ok":true,"note":"Open VS Code: done (it was already open, so it switched to it)"}]}\\n' "$3" ;;
    esac ;;
  state) echo '{"v":1,"active_workspace":2,"workspaces":[{"id":2,"layout":"tiled","windows":[{"app":"vscode","focused":true,"floating":false,"fullscreen":false}]}],"scratchpad":0}' ;;
  *) echo "Function not found." >&2; exit 1 ;;
esac
`;

function makeFake(mode = "ok") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omacommand-test-"));
  const file = path.join(dir, "omarchy-shell");
  fs.writeFileSync(file, FAKE);
  fs.chmodSync(file, 0o755);
  fs.writeFileSync(path.join(dir, "mode"), mode);
  return {
    dir,
    calls: () => (fs.existsSync(path.join(dir, "calls.log")) ? fs.readFileSync(path.join(dir, "calls.log"), "utf8").trim().split("\n").filter(Boolean) : []),
    proposal: () => JSON.parse(fs.readFileSync(path.join(dir, "propose.json"), "utf8")),
    setMode: (m) => fs.writeFileSync(path.join(dir, "mode"), m),
    remove: () => fs.rmSync(dir, { recursive: true, force: true })
  };
}

// ---------------------------------------------------------------- a client for the server
function startServer(opts = {}) {
  const pathParts = [];
  if (opts.fake) pathParts.push(opts.fake.dir);
  if (opts.emptyPath) pathParts.push(opts.emptyPath);
  if (!opts.emptyPath) pathParts.push(process.env.PATH || "");
  const env = Object.assign({}, process.env, { PATH: pathParts.join(path.delimiter), XDG_RUNTIME_DIR: os.tmpdir() }, opts.env || {});
  const child = spawn(RUBY, ["--disable=gems,rubyopt", SERVER, ...(opts.args || [])], { env, stdio: ["pipe", "pipe", "pipe"] });
  const c = { child, lines: [], stderr: "", exitCode: null, waiters: [] };
  let buf = "";
  const poke = () => c.waiters.slice().forEach((w) => w());
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      c.lines.push(buf.slice(0, i).replace(/\r$/, ""));
      buf = buf.slice(i + 1);
    }
    poke();
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (d) => { c.stderr += d; });
  child.on("exit", (code) => { c.exitCode = code === null ? -1 : code; poke(); });
  child.stdin.on("error", () => {});
  c.send = (o) => child.stdin.write((typeof o === "string" ? o : JSON.stringify(o)) + "\n");
  c.messages = () => c.lines.map((l) => { try { return JSON.parse(l); } catch (e) { return { notJson: l }; } });
  c.until = (pred, ms = 20000) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => { c.waiters = c.waiters.filter((w) => w !== check); reject(new Error("timed out; stdout so far: " + JSON.stringify(c.lines).slice(0, 600) + "; stderr: " + c.stderr)); }, ms);
    const check = () => {
      const hit = pred(c);
      if (hit) { clearTimeout(timer); c.waiters = c.waiters.filter((w) => w !== check); resolve(hit); }
    };
    c.waiters.push(check);
    check();
  });
  c.reply = (id, ms) => c.until((x) => x.messages().find((m) => m.id === id && (m.result !== undefined || m.error !== undefined)), ms);
  c.close = async () => {
    child.stdin.end();
    await c.until((x) => x.exitCode !== null, 10000).catch(() => child.kill());
  };
  return c;
}

const INIT = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test-agent", version: "0" } } };
const call = (id, name, args, extra) => Object.assign({ jsonrpc: "2.0", id, method: "tools/call", params: Object.assign({ name, arguments: args }, extra || {}) });
const textOf = (reply) => reply.result.content[0].text;

async function withServer(opts, fn) {
  const c = startServer(opts);
  try {
    c.send(INIT);
    await c.reply(1);
    await fn(c);
  } finally {
    await c.close();
  }
}

// ---------------------------------------------------------------- the protocol
test("initialize answers the client's protocol version if known, capabilities tools only", { skip: skipRuby, timeout: 30000 }, async () => {
  const c = startServer();
  try {
    c.send(INIT);
    const r = await c.reply(1);
    assert.equal(r.result.protocolVersion, "2025-06-18");
    assert.deepEqual(r.result.capabilities, { tools: {} });
    assert.equal(r.result.serverInfo.name, "omacommand");
    assert.equal(r.result.serverInfo.version, "1.0.0");
    assert.equal(typeof r.result.instructions, "string");
    c.send({ jsonrpc: "2.0", id: 2, method: "initialize", params: { protocolVersion: "1999-01-01" } });
    const r2 = await c.reply(2);
    assert.equal(r2.result.protocolVersion, "2025-11-25", "the newest known version for an unknown one");
    c.send({ jsonrpc: "2.0", method: "notifications/initialized" });
    c.send({ jsonrpc: "2.0", id: 3, method: "ping" });
    assert.deepEqual((await c.reply(3)).result, {});
    assert.equal(c.messages().filter((m) => m.id === undefined).length, 0, "a notification gets no answer");
  } finally {
    await c.close();
  }
});

test("tools/list returns the three tools of mcp/tools.json", { skip: skipRuby, timeout: 30000 }, async () => {
  await withServer({}, async (c) => {
    c.send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    const r = await c.reply(2);
    const onDisk = JSON.parse(fs.readFileSync(path.join(ROOT, "mcp", "tools.json"), "utf8"));
    assert.deepEqual(r.result.tools, onDisk.tools);
    assert.deepEqual(r.result.tools.map((t) => t.name), ["propose_desk_plan", "desk_plan_result", "desk_state"]);
  });
});

test("an unknown method gets -32601, and so does server/discover", { skip: skipRuby, timeout: 30000 }, async () => {
  await withServer({}, async (c) => {
    for (const [id, method] of [[10, "server/discover"], [11, "resources/list"], [12, "completion/complete"], [13, "tools/run"]]) {
      c.send({ jsonrpc: "2.0", id, method });
      const r = await c.reply(id);
      assert.equal(r.error.code, -32601, method);
    }
    c.send({ jsonrpc: "2.0", method: "notifications/whatever" });
    c.send({ jsonrpc: "2.0", id: 14, method: "ping" });
    assert.deepEqual((await c.reply(14)).result, {});
  });
});

test("an unknown tool is refused, and so is anything but an object as arguments", { skip: skipRuby, timeout: 30000 }, async () => {
  await withServer({}, async (c) => {
    c.send(call(20, "run_shell", {}));
    assert.equal((await c.reply(20)).error.code, -32602);
    c.send(call(21, "constructor", {}));
    assert.equal((await c.reply(21)).error.code, -32602);
    let id = 30;
    for (const bad of [[], "steps", 5, null, true]) {
      id++;
      c.send(call(id, "propose_desk_plan", bad));
      const r = await c.reply(id);
      assert.equal(r.error.code, -32602, JSON.stringify(bad));
    }
    c.send({ jsonrpc: "2.0", id: 40, method: "tools/call", params: { arguments: {} } });
    assert.equal((await c.reply(40)).error.code, -32602, "no tool name");
    c.send({ jsonrpc: "2.0", id: 41, method: "tools/call", params: "x" });
    assert.equal((await c.reply(41)).error.code, -32602, "params that are not an object");
  });
});

test("bad JSON-RPC envelopes are refused without stopping the server", { skip: skipRuby, timeout: 30000 }, async () => {
  await withServer({}, async (c) => {
    c.send("not json");
    c.send("[1,2,3]");
    c.send({ jsonrpc: "1.0", id: 50, method: "ping" });
    c.send({ jsonrpc: "2.0", id: { a: 1 }, method: "ping" });
    c.send({ jsonrpc: "2.0", id: 51, method: 7 });
    c.send({ jsonrpc: "2.0", id: 52, method: "ping" });
    assert.deepEqual((await c.reply(52)).result, {});
    const errors = c.messages().filter((m) => m.error);
    assert.ok(errors.length >= 4, JSON.stringify(errors));
    assert.ok(errors.every((m) => [-32700, -32600].includes(m.error.code)), JSON.stringify(errors));
  });
});

test("a 70,000-byte line is refused, and the next line still works", { skip: skipRuby, timeout: 30000 }, async () => {
  await withServer({}, async (c) => {
    c.send("x".repeat(70000));
    c.send({ jsonrpc: "2.0", id: 60, method: "ping" });
    assert.deepEqual((await c.reply(60)).result, {});
    const long = c.messages().filter((m) => m.error && m.id === null);
    assert.equal(long.length, 1);
    assert.equal(long[0].error.code, -32700);
    // A line far over the limit, with the newline much later, is also read away.
    c.send("y".repeat(400000));
    c.send({ jsonrpc: "2.0", id: 61, method: "ping" });
    assert.deepEqual((await c.reply(61)).result, {});
  });
});

test("a line of exactly 65,536 bytes is read, one byte more is not", { skip: skipRuby, timeout: 30000 }, async () => {
  await withServer({}, async (c) => {
    const base = JSON.stringify({ jsonrpc: "2.0", id: 70, method: "ping", params: { pad: "" } });
    const pad = "a".repeat(65536 - base.length);
    const line = JSON.stringify({ jsonrpc: "2.0", id: 70, method: "ping", params: { pad } });
    assert.equal(Buffer.byteLength(line), 65536);
    c.send(line);
    assert.deepEqual((await c.reply(70)).result, {});
    c.send(line.replace('"pad":"', '"pad":"a'));
    c.send({ jsonrpc: "2.0", id: 71, method: "ping" });
    assert.deepEqual((await c.reply(71)).result, {});
    assert.equal(c.messages().filter((m) => m.id === 70).length, 1, "the longer line got no answer as a ping");
  });
});

test("JSON nested 17 deep is refused, and the server goes on", { skip: skipRuby, timeout: 30000 }, async () => {
  await withServer({}, async (c) => {
    c.send("[".repeat(17) + "]".repeat(17));
    c.send(JSON.stringify({ jsonrpc: "2.0", id: 80, method: "ping" }).replace("}", ',"params":' + "[".repeat(17) + "]".repeat(17) + "}"));
    c.send({ jsonrpc: "2.0", id: 81, method: "ping" });
    assert.deepEqual((await c.reply(81)).result, {});
    const errors = c.messages().filter((m) => m.error);
    assert.equal(errors.length, 2);
    assert.ok(errors.every((m) => m.error.code === -32700));
    assert.ok(!c.messages().some((m) => m.id === 80), "the deep message was not answered as a ping");
  });
});

test("a value that cannot be written back is refused, not crashed on", { skip: skipFake, timeout: 30000 }, async () => {
  const fake = makeFake();
  try {
    await withServer({ fake }, async (c) => {
      // JSON.stringify would turn 1e309 into null, so the line is written by hand.
      c.send('{"jsonrpc":"2.0","id":90,"method":"tools/call","params":{"name":"propose_desk_plan","arguments":{"steps":[{"do":"workspace","to":1e309}]}}}');
      const r = await c.reply(90);
      assert.equal(r.result.isError, true);
      assert.equal(textOf(r), "The request could not be written.");
      c.send({ jsonrpc: "2.0", id: 91, method: "ping" });
      assert.deepEqual((await c.reply(91)).result, {});
    });
    assert.deepEqual(fake.calls(), [], "nothing was sent to the shell");
  } finally {
    fake.remove();
  }
});

test("a plan over 16 KiB is refused before anything is sent", { skip: skipFake, timeout: 30000 }, async () => {
  const fake = makeFake();
  try {
    await withServer({ fake }, async (c) => {
      c.send(call(100, "propose_desk_plan", { steps: [{ do: "workspace", to: 1, extra: "a".repeat(20000) }] }));
      const r = await c.reply(100);
      assert.equal(r.result.isError, true);
      assert.equal(textOf(r), "The request is too large.");
    });
    assert.deepEqual(fake.calls(), []);
  } finally {
    fake.remove();
  }
});

test("bad arguments to the three tools are plain sentences, not calls to the shell", { skip: skipFake, timeout: 30000 }, async () => {
  const fake = makeFake();
  try {
    await withServer({ fake }, async (c) => {
      c.send(call(110, "propose_desk_plan", {}));
      assert.equal((await c.reply(110)).result.isError, true);
      c.send(call(111, "propose_desk_plan", { steps: "x" }));
      assert.equal((await c.reply(111)).result.isError, true);
      c.send(call(112, "propose_desk_plan", { steps: [], title: "x" }));
      assert.equal((await c.reply(112)).result.isError, true);
      c.send(call(113, "desk_plan_result", { id: "nope" }));
      assert.equal((await c.reply(113)).result.isError, true);
      c.send(call(114, "desk_plan_result", { id: "0".repeat(32) }));
      assert.equal(textOf(await c.reply(114)), "Omacommand does not know that request id.");
      c.send(call(115, "desk_state", { x: 1 }));
      assert.equal((await c.reply(115)).result.isError, true);
    });
    assert.deepEqual(fake.calls(), []);
  } finally {
    fake.remove();
  }
});

// ---------------------------------------------------------------- the shell is missing, or misbehaves
test("with omarchy-shell missing the server says so in a fixed sentence", { skip: skipFake, timeout: 30000 }, async () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "omacommand-empty-"));
  try {
    await withServer({ emptyPath: empty }, async (c) => {
      c.send(call(120, "propose_desk_plan", { steps: [{ do: "workspace", to: 2 }] }));
      const r = await c.reply(120);
      assert.equal(r.result.isError, true);
      assert.equal(textOf(r), "The Omarchy shell is not running, so no box can be shown. Nothing ran.");
      c.send(call(121, "desk_state", {}));
      assert.equal(textOf(await c.reply(121)), "The Omarchy shell is not running, so no box can be shown. Nothing ran.");
    });
  } finally {
    fs.rmSync(empty, { recursive: true, force: true });
  }
});

test("the shell's own answers map to the sentences of spec 7.5", { skip: skipFake, timeout: 60000 }, async () => {
  const cases = [
    ["not_running", "The Omarchy shell is not running, so no box can be shown. Nothing ran."],
    ["not_enabled", "Omacommand is not enabled. Ask the person to run: omarchy plugin enable " + TARGET]
  ];
  for (const [mode, sentence] of cases) {
    const fake = makeFake(mode);
    try {
      await withServer({ fake }, async (c) => {
        c.send(call(130, "propose_desk_plan", { steps: [{ do: "workspace", to: 2 }] }));
        const r = await c.reply(130);
        assert.equal(textOf(r), sentence, mode);
        assert.equal(r.result.isError, true);
      });
      const calls = fake.calls();
      if (mode === "not_enabled") assert.equal(calls.length, 2, "asked once more after a second");
    } finally {
      fake.remove();
    }
  }
});

test("a hung child is killed after 5 s and the sentence says the shell did not answer", { skip: skipFake, timeout: 60000 }, async () => {
  const fake = makeFake("hung");
  try {
    await withServer({ fake }, async (c) => {
      const t0 = Date.now();
      c.send(call(140, "desk_state", {}));
      const r = await c.reply(140, 30000);
      const took = Date.now() - t0;
      assert.equal(textOf(r), "The Omarchy shell did not answer, so no box was shown. Nothing ran.");
      assert.ok(took >= 4800 && took < 9000, "took " + took + " ms");
      const pid = Number(fs.readFileSync(path.join(fake.dir, "pid"), "utf8").trim());
      await sleep(1500);
      assert.throws(() => process.kill(pid, 0), (e) => e.code === "ESRCH", "the child is still running");
    });
  } finally {
    fake.remove();
  }
});

// ---------------------------------------------------------------- a normal request
test("propose_desk_plan sends the request of spec 6.3 and reports each step", { skip: skipFake, timeout: 60000 }, async () => {
  const fake = makeFake("ok");
  try {
    await withServer({ fake }, async (c) => {
      const steps = [{ do: "workspace", to: 2 }, { do: "open", app: "vscode" }];
      c.send(call(150, "propose_desk_plan", { steps }));
      const r = await c.reply(150);
      assert.equal(r.result.isError, false);
      assert.equal(
        textOf(r),
        "The person allowed it. All 2 steps ran. 1. Go to workspace 2: done. 2. Open VS Code: done (it was already open, so it switched to it)."
      );
      const sent = fake.proposal();
      assert.deepEqual(Object.keys(sent).sort(), ["client", "id", "plan", "sent_at", "v"]);
      assert.equal(sent.v, 1);
      assert.match(sent.id, /^[0-9a-f]{32}$/);
      assert.ok(Math.abs(Date.now() - sent.sent_at) < 15000);
      assert.equal(sent.client, "test-agent");
      assert.deepEqual(sent.plan, { steps }, "the plan is passed through untouched");
    });
    const calls = fake.calls();
    assert.equal(calls[0].split(" ")[0], TARGET);
    assert.equal(calls[0].split(" ")[1], "propose");
    assert.ok(calls.slice(1).every((l) => l.startsWith(TARGET + " status ")));
  } finally {
    fake.remove();
  }
});

test("the agent's name is passed on only if it is plain", { skip: skipFake, timeout: 60000 }, async () => {
  const fake = makeFake("ok");
  try {
    const c = startServer({ fake });
    try {
      c.send(Object.assign({}, INIT, { params: Object.assign({}, INIT.params, { clientInfo: { name: "evil" + String.fromCharCode(27) + "[31m <b>" } }) }));
      await c.reply(1);
      c.send(call(160, "propose_desk_plan", { steps: [{ do: "workspace", to: 2 }] }));
      await c.reply(160);
      assert.equal(fake.proposal().client, "unknown");
    } finally {
      await c.close();
    }
  } finally {
    fake.remove();
  }
});

test("a refusal, a no and a failed step come back as plain sentences", { skip: skipFake, timeout: 90000 }, async () => {
  const cases = [
    ["refuse", "Step 1: that app is not on Omacommand's list.", true],
    ["denied", "The person said no. Nothing ran.", false],
    ["failed", "Step 2 failed: Spotify is not open. The steps after it did not run. 1. Go to workspace 2: done.", true]
  ];
  for (const [mode, sentence, isError] of cases) {
    const fake = makeFake(mode);
    try {
      await withServer({ fake }, async (c) => {
        c.send(call(170, "propose_desk_plan", { steps: [{ do: "workspace", to: 2 }] }));
        const r = await c.reply(170);
        assert.equal(textOf(r), sentence, mode);
        assert.equal(r.result.isError, isError, mode);
      });
    } finally {
      fake.remove();
    }
  }
});

test("a restart of the shell while waiting is told as the spec says", { skip: skipFake, timeout: 90000 }, async () => {
  const cases = [
    ["restart_waiting", "The Omarchy shell restarted while your request was waiting, so nothing ran."],
    ["restart_running", "The Omarchy shell restarted while the steps were running. Some steps may have run; call desk_state to see the desktop now."]
  ];
  for (const [mode, sentence] of cases) {
    const fake = makeFake(mode);
    try {
      await withServer({ fake }, async (c) => {
        c.send(call(180, "propose_desk_plan", { steps: [{ do: "workspace", to: 2 }] }));
        assert.equal(textOf(await c.reply(180)), sentence, mode);
      });
    } finally {
      fake.remove();
    }
  }
});

test("when propose itself times out, the server asks for the record before giving up", { skip: skipFake, timeout: 60000 }, async () => {
  const fake = makeFake("not_responding");
  try {
    await withServer({ fake }, async (c) => {
      c.send(call(190, "propose_desk_plan", { steps: [{ do: "workspace", to: 2 }] }));
      const r = await c.reply(190, 30000);
      // The fake never stored the proposal, so every status answer is about an unknown id.
      assert.equal(textOf(r), "The Omarchy shell did not answer, so no box was shown. Nothing ran.");
      assert.equal(r.result.isError, true);
    });
    const statusCalls = fake.calls().filter((l) => l.includes(" status "));
    assert.equal(statusCalls.length, 3, "the record was asked for three times");
  } finally {
    fake.remove();
  }
});

// The 50 s answer limit and the worst case of one status call (review C13). A propose that the shell refuses still makes its id
// known to the server, so desk_plan_result can be asked about it with the mode switched afterwards.
test("when the last status check fails, the answer says the shell did not answer and points at desk_plan_result, never 'nothing ran' (review C13)", { skip: skipFake, timeout: 90000 }, async () => {
  const fake = makeFake("refuse");
  try {
    await withServer({ fake }, async (c) => {
      c.send(call(300, "propose_desk_plan", { steps: [{ do: "workspace", to: 2 }] }));
      await c.reply(300);
      await sleep(300); // the server takes one call at a time: let the first one finish completely
      const id = fake.proposal().id;
      fake.setMode("status_fails");
      const t0 = Date.now();
      c.send(call(301, "desk_plan_result", { id }));
      const r = await c.reply(301, 40000);
      const took = Date.now() - t0;
      const text = textOf(r);
      assert.equal(r.result.isError, true);
      assert.equal(
        text,
        "The Omarchy shell did not answer the last check, so the request may still be waiting for the person or running. Call desk_plan_result with id " + id + " in a few seconds."
      );
      assert.ok(!/Nothing ran|nothing ran|restarted/.test(text));
      // The window is 20 s and no poll starts when less than 7 s would be left: the answer comes after about 13 s.
      assert.ok(took >= 12000 && took < 17500, "took " + took + " ms");
    });
  } finally {
    fake.remove();
  }
});

test("propose_desk_plan answers about 7 s before the 50 s limit, so even a slow status call cannot push it past a 60 s client (review C13)", { skip: skipFake, timeout: 120000 }, async () => {
  const fake = makeFake("slow");
  try {
    await withServer({ fake }, async (c) => {
      const t0 = Date.now();
      c.send(call(310, "propose_desk_plan", { steps: [{ do: "workspace", to: 2 }] }));
      const r = await c.reply(310, 70000);
      const took = Date.now() - t0;
      const id = fake.proposal().id;
      assert.equal(textOf(r), "Still waiting for the person to answer. Call desk_plan_result with id " + id + " in a few seconds.");
      assert.ok(took >= 41000 && took < 47000, "took " + took + " ms");
    });
  } finally {
    fake.remove();
  }
});

test("desk_state returns the service's JSON as text", { skip: skipFake, timeout: 30000 }, async () => {
  const fake = makeFake("ok");
  try {
    await withServer({ fake }, async (c) => {
      c.send(call(200, "desk_state", {}));
      const r = await c.reply(200);
      assert.equal(r.result.isError, false);
      const state = JSON.parse(textOf(r));
      assert.equal(state.active_workspace, 2);
      assert.equal(state.workspaces[0].windows[0].app, "vscode");
    });
  } finally {
    fake.remove();
  }
});

test("while a request waits, progress notifications arrive every 5 s if the client asked", { skip: skipFake, timeout: 90000 }, async () => {
  const fake = makeFake("slow");
  try {
    const c = startServer({ fake });
    try {
      c.send(INIT);
      await c.reply(1);
      c.send(call(210, "propose_desk_plan", { steps: [{ do: "workspace", to: 2 }] }, { _meta: { progressToken: "tok-1" } }));
      const p = await c.until((x) => x.messages().find((m) => m.method === "notifications/progress"), 20000);
      assert.equal(p.params.progressToken, "tok-1");
      assert.equal(typeof p.params.progress, "number");
      assert.match(p.params.message, /^[\x20-\x7E]+$/);
      c.send({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 210 } });
      c.send({ jsonrpc: "2.0", id: 211, method: "ping" });
      assert.deepEqual((await c.reply(211)).result, {});
    } finally {
      await c.close();
    }
  } finally {
    fake.remove();
  }
});

test("stdout carries only valid JSON-RPC lines, stderr stays empty", { skip: skipFake, timeout: 60000 }, async () => {
  const fake = makeFake("ok");
  const c = startServer({ fake });
  try {
    c.send(INIT);
    c.send("garbage {");
    c.send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    c.send(call(3, "desk_state", {}));
    c.send(call(4, "propose_desk_plan", { steps: [{ do: "workspace", to: 2 }] }));
    c.send({ jsonrpc: "2.0", id: 5, method: "nope" });
    await c.reply(4, 30000);
    await c.reply(5);
    await c.close();
    assert.ok(c.lines.length >= 6);
    for (const line of c.lines) {
      const m = JSON.parse(line);
      assert.equal(m.jsonrpc, "2.0", line);
      assert.ok("id" in m || "method" in m, line);
    }
    assert.equal(c.stderr, "");
  } finally {
    fake.remove();
  }
});

test("control characters in the shell's answers cannot reach the agent", { skip: skipFake, timeout: 60000 }, async () => {
  const fake = makeFake("ok");
  try {
    // A fake that answers with an escape character (as a JSON escape) in the message. printf turns two backslashes into one.
    const bs = String.fromCharCode(92, 92);
    const script = fs.readFileSync(path.join(fake.dir, "omarchy-shell"), "utf8");
    fs.writeFileSync(path.join(fake.dir, "omarchy-shell"), script.replace(
      "The person allowed it. All 2 steps ran.",
      "The person allowed it." + bs + "u001b[31m All 2 steps ran."
    ));
    await withServer({ fake }, async (c) => {
      c.send(call(220, "propose_desk_plan", { steps: [{ do: "workspace", to: 2 }] }));
      const r = await c.reply(220, 30000);
      assert.match(textOf(r), /^[\x20-\x7E]+$/);
      assert.ok(textOf(r).startsWith("The person allowed it."));
    });
  } finally {
    fake.remove();
  }
});

// ---------------------------------------------------------------- --check, --version, flags
// A copy of the plugin in a folder that is not a git checkout, so the result does not depend on this working copy.
function copyPlugin() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omacommand-plugin-"));
  fs.mkdirSync(path.join(dir, "mcp"));
  for (const f of ["manifest.json", "mcp/server.rb", "mcp/tools.json"]) fs.copyFileSync(path.join(ROOT, f), path.join(dir, f));
  return { dir, server: path.join(dir, "mcp", "server.rb"), remove: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test("--check prints OK and NOTE lines and exits 0 when everything is in place", { skip: skipFake, timeout: 60000 }, () => {
  const fake = makeFake("ok");
  const plugin = copyPlugin();
  try {
    const r = spawnSync(RUBY, ["--disable=gems,rubyopt", plugin.server, "--check"], {
      encoding: "utf8", env: Object.assign({}, process.env, { PATH: fake.dir + path.delimiter + (process.env.PATH || ""), XDG_RUNTIME_DIR: os.tmpdir(), OMARCHY_PATH: os.tmpdir() })
    });
    const lines = r.stdout.trim().split("\n");
    assert.ok(lines.every((l) => /^(OK|FIX|NOTE) [\x20-\x7E]+$/.test(l)), r.stdout);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.ok(lines.filter((l) => l.startsWith("OK")).length >= 7);
    assert.ok(lines.includes("OK OMARCHY_PATH is set."), r.stdout);
    assert.ok(lines.at(-1).startsWith("NOTE If your agent can run terminal commands without asking you"));
    assert.deepEqual(fake.calls().map((l) => l.split(" ").slice(0, 2).join(" ")), [TARGET + " ping"], "it only pings: it never proposes");
    assert.equal(r.stderr, "");
  } finally {
    fake.remove();
    plugin.remove();
  }
});

test("--check says what to fix, with the exact command", { skip: skipFake, timeout: 60000 }, () => {
  const fake = makeFake("not_enabled");
  const plugin = copyPlugin();
  try {
    const r = spawnSync(RUBY, ["--disable=gems,rubyopt", plugin.server, "--check"], {
      encoding: "utf8", env: Object.assign({}, process.env, { PATH: fake.dir + path.delimiter + (process.env.PATH || ""), XDG_RUNTIME_DIR: os.tmpdir(), OMARCHY_PATH: os.tmpdir() })
    });
    assert.equal(r.status, 1);
    assert.ok(r.stdout.split("\n").includes("FIX Omacommand is not enabled : omarchy plugin enable " + TARGET), r.stdout);
    const none = spawnSync(RUBY, ["--disable=gems,rubyopt", plugin.server, "--check"], {
      encoding: "utf8", env: Object.assign({}, process.env, { PATH: os.tmpdir(), XDG_RUNTIME_DIR: "", OMARCHY_PATH: "" })
    });
    assert.equal(none.status, 1);
    assert.match(none.stdout, /^FIX XDG_RUNTIME_DIR is not set : run this from a terminal in your Omarchy desktop\.$/m);
    assert.match(none.stdout, /^FIX omarchy-shell was not found on PATH/m);
    assert.match(none.stdout, /^FIX OMARCHY_PATH is not set : run this from a terminal in your Omarchy desktop, where omarchy-shell can find the shell\.$/m);
  } finally {
    fake.remove();
    plugin.remove();
  }
});

test("--check names OMARCHY_PATH when it is not set (a terminal over SSH), and does not send the person to rescanPlugins (review C14)", { skip: skipFake, timeout: 60000 }, () => {
  const fake = makeFake("needs_path"); // the fake answers like omarchy-shell does without OMARCHY_PATH
  const plugin = copyPlugin();
  try {
    const unset = spawnSync(RUBY, ["--disable=gems,rubyopt", plugin.server, "--check"], {
      encoding: "utf8", env: Object.assign({}, process.env, { PATH: fake.dir + path.delimiter + (process.env.PATH || ""), XDG_RUNTIME_DIR: os.tmpdir(), OMARCHY_PATH: "" })
    });
    assert.equal(unset.status, 1);
    const lines = unset.stdout.split("\n");
    assert.ok(lines.some((l) => /^FIX OMARCHY_PATH is not set : /.test(l)), unset.stdout);
    assert.ok(lines.some((l) => /^FIX Omacommand could not be asked, because OMARCHY_PATH is not set : /.test(l)), unset.stdout);
    assert.ok(!unset.stdout.includes("rescanPlugins"), unset.stdout);
    const set = spawnSync(RUBY, ["--disable=gems,rubyopt", plugin.server, "--check"], {
      encoding: "utf8", env: Object.assign({}, process.env, { PATH: fake.dir + path.delimiter + (process.env.PATH || ""), XDG_RUNTIME_DIR: os.tmpdir(), OMARCHY_PATH: os.tmpdir() })
    });
    assert.equal(set.status, 0, set.stdout);
    assert.ok(set.stdout.split("\n").includes("OK OMARCHY_PATH is set."));
  } finally {
    fake.remove();
    plugin.remove();
  }
});

test("--check says it could not check when git status fails, instead of saying the files are as installed (review C14)", { skip: skipFake, timeout: 60000 }, () => {
  const fake = makeFake("ok");
  const plugin = copyPlugin();
  try {
    // A git that finds the commit and then fails on status, as it does for a folder it does not trust.
    const gitFile = path.join(fake.dir, "git");
    fs.writeFileSync(gitFile, [
      "#!/bin/sh",
      "case \"$3\" in",
      "  rev-parse) echo 0123456789abcdef0123456789abcdef01234567 ;;",
      "  status) echo \"fatal: detected dubious ownership\" >&2; exit 128 ;;",
      "esac",
      ""
    ].join("\n"));
    fs.chmodSync(gitFile, 0o755);
    const r = spawnSync(RUBY, ["--disable=gems,rubyopt", plugin.server, "--check"], {
      encoding: "utf8", env: Object.assign({}, process.env, { PATH: fake.dir + path.delimiter + (process.env.PATH || ""), XDG_RUNTIME_DIR: os.tmpdir(), OMARCHY_PATH: os.tmpdir() })
    });
    assert.equal(r.status, 1, r.stdout);
    const lines = r.stdout.split("\n");
    assert.ok(lines.some((l) => /^FIX Could not check whether Omacommand's files were changed after they were added, because git status failed : git -C .+ status --porcelain$/.test(l)), r.stdout);
    assert.ok(!lines.includes("OK The files are as they were installed."), r.stdout);
    assert.ok(lines.some((l) => l.startsWith("OK The installed commit is 0123456789abcdef0123456789abcdef01234567")), r.stdout);
  } finally {
    fake.remove();
    plugin.remove();
  }
});

test("--check with a changed plugin folder under git warns that the files were changed", { skip: skipFake, timeout: 60000 }, () => {
  const git = spawnSync("git", ["--version"], { encoding: "utf8" });
  if (git.error || git.status !== 0) return;
  const fake = makeFake("ok");
  const plugin = copyPlugin();
  try {
    const run = (args) => spawnSync("git", ["-C", plugin.dir, "-c", "user.name=t", "-c", "user.email=t@users.noreply.github.com", "-c", "commit.gpgsign=false", ...args], { encoding: "utf8" });
    assert.equal(run(["init", "-q"]).status, 0);
    assert.equal(run(["add", "-A"]).status, 0);
    assert.equal(run(["commit", "-q", "-m", "x"]).status, 0);
    const env = Object.assign({}, process.env, { PATH: fake.dir + path.delimiter + (process.env.PATH || ""), XDG_RUNTIME_DIR: os.tmpdir(), OMARCHY_PATH: os.tmpdir() });
    const clean = spawnSync(RUBY, ["--disable=gems,rubyopt", plugin.server, "--check"], { encoding: "utf8", env });
    assert.equal(clean.status, 0, clean.stdout);
    assert.match(clean.stdout, /^OK The installed commit is [0-9a-f]{40} : compare it with CHANGELOG\.md on GitHub\.$/m);
    fs.appendFileSync(path.join(plugin.dir, "mcp", "tools.json"), " ");
    const changed = spawnSync(RUBY, ["--disable=gems,rubyopt", plugin.server, "--check"], { encoding: "utf8", env });
    assert.equal(changed.status, 1);
    assert.match(changed.stdout, /^FIX Omacommand's files were changed after it was installed\. If you did not change them, reinstall : /m);
  } finally {
    fake.remove();
    plugin.remove();
  }
});

test("--version prints the version, an unknown flag prints the usage and exits 2", { skip: skipRuby, timeout: 30000 }, () => {
  const v = spawnSync(RUBY, ["--disable=gems,rubyopt", SERVER, "--version"], { encoding: "utf8" });
  assert.equal(v.stdout.replace(/\r\n/g, "\n"), "omacommand 1.0.0\n");
  assert.equal(v.status, 0);
  for (const args of [["--bogus"], ["--check", "--bogus"], ["serve"], ["--check", "--log", "extra"]]) {
    const r = spawnSync(RUBY, ["--disable=gems,rubyopt", SERVER, ...args], { encoding: "utf8" });
    assert.equal(r.status, 2, args.join(" "));
    assert.equal(r.stdout, "", "usage goes to stderr");
    assert.match(r.stderr, /^usage: server\.rb/);
  }
});

test("the server exits quietly when its input ends", { skip: skipRuby, timeout: 30000 }, async () => {
  const c = startServer();
  c.child.stdin.end();
  await c.until((x) => x.exitCode !== null, 10000);
  assert.equal(c.exitCode, 0);
  assert.equal(c.stderr, "");
  assert.deepEqual(c.lines, []);
});

// One test always runs, so a machine without Ruby shows the reason in the summary instead of a silent gap.
test("the Ruby tests need Ruby 3: this says whether they ran", (t) => {
  if (NO_RUBY) {
    t.diagnostic(NO_RUBY);
  } else {
    const v = spawnSync(RUBY, ["-e", "print RUBY_VERSION"], { encoding: "utf8" }).stdout;
    assert.ok(Number(v.split(".")[0]) >= 3, "Ruby " + v + " is older than 3.0");
  }
});
