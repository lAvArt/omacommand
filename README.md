# Omacommand: let your AI agent arrange your desktop, with your OK each time

Omacommand is an Omarchy plugin. With it, an AI agent on your computer, such as Claude Code, can switch workspaces, open
apps and arrange windows for you. Every request appears first in a box on your screen. Nothing happens until you click
**Allow**.

## How it works

1. You ask your agent something like: *"Put VS Code and the browser side by side on workspace 2."*
2. The agent cannot touch your desktop through Omacommand. It can only **propose** a few steps, taken from a fixed list.
3. A box appears in the middle of your screen:

   ```
   +----------------------------------------------+
   |  An AI agent on this computer wants to:      |
   |    1. Go to workspace 2                      |
   |    2. Open VS Code                           |
   |    3. Open Browser to the right of the       |
   |       current window                         |
   |                                              |
   |       [ Deny ]    [ Allow ]                  |
   +----------------------------------------------+
   ```

4. **Allow** runs exactly those steps, and the agent is told how each one went. **Deny**, **Esc**, or no answer within
   45 seconds means nothing happens, and the agent is told you said no.

Why this is safe:
- **A fixed list.** The agent picks steps from a short menu (below). It can never send its own commands, web addresses or
  text.
- **What you see is what runs.** The box is written by Omacommand from that menu, never by the agent.
- **Nothing leaves your computer.** There is no internet connection, no account, no server and no open port. The agent and
  Omacommand talk directly on this machine.
- **Never possible:** shutting down or restarting, installing or removing software, taking screenshots, and anything that
  needs your password.
- **Like your own keys.** Steps do only what Omarchy's own keys do, including the state they keep. The night light, the gaps
  between windows and the layout choice, for example, are remembered the way the keys remember them. Omacommand itself never
  edits your settings (see "What it writes").

## Setup: two steps, about two minutes

**Before you start:** Omarchy 4 or newer. Nothing else is needed. Ruby comes with every Omarchy install.

**Step 1: add the plugin.** In a terminal:

```bash
omarchy plugin add https://github.com/lAvArt/omacommand --enable
```

Omarchy warns that plugins run with your user's rights and asks you to confirm. Answer yes. A welcome box then shows the
command for Step 2, with a **Copy** button.

**Step 2: connect your agent.** For Claude Code, run this once (or paste it from the welcome box):

```bash
claude mcp add --scope user omacommand -- /usr/bin/ruby --disable=gems,rubyopt ~/.config/omarchy/plugins/io.github.lavart.omacommand/mcp/server.rb
```

Then restart Claude Code.

**Try it:** ask your agent *"Go to workspace 2."* When the box appears, you are done.

There is nothing else to download, no keys to create and no settings files to edit by hand.

<details>
<summary>Other agents (any app that supports MCP)</summary>

Add this server to the agent's MCP settings. Replace `YOU` with your user name:

```json
{
  "mcpServers": {
    "omacommand": {
      "command": "/usr/bin/ruby",
      "args": ["--disable=gems,rubyopt", "/home/YOU/.config/omarchy/plugins/io.github.lavart.omacommand/mcp/server.rb"]
    }
  }
}
```

The agent gets three tools:
- `propose_desk_plan`: ask to run steps (1 to 12 of them);
- `desk_plan_result`: collect the result of a run that was still going after about 50 seconds;
- `desk_state`: see the active workspace and which apps from the list are open on which workspace.

Claude Code may ask you before each tool call. You can allow Omacommand's three tools there, because the box asks you
again anyway. Do not allow terminal commands broadly (see below).
</details>

## What you can ask for

- **Workspaces:** go to workspace 1 to 10, move a window to another one.
- **Apps:** open the terminal, browser, file manager, VS Code, Obsidian, Spotify or btop. The terminal, file manager and
  VS Code can open in a folder inside your home folder, and any app can open to the left, right, above or below the current
  window. Opening beside the current window needs the tiled layout (the default); in the scrolling layout the window may not
  land where you asked. Spotify has to be there already: Omacommand never adds software, and says so if Spotify is missing.
- **Windows:** focus, swap, resize, float, full screen, full width, pop out, toggle the split, group into tabs, pin, center,
  transparency, put away in the scratchpad.
- **Layout:** tile the windows on a workspace, or put them in a scrolling row.
- **Small things:** volume, brightness, play and pause music, next and previous track, night light, gaps between windows,
  lock the screen, show the time or the battery level in a notification.
- **Closing one window.** The box says exactly which window (app and workspace) and warns that unsaved work in it may be
  lost.

Up to 12 steps per request. Every step uses Omarchy's own commands, the same ones its keys run. The volume, brightness and
music steps are waited for: if one of them fails, the agent is told, and the steps after it do not run.

## The box, in detail

- **Allow is a mouse or touch click only, and it becomes clickable one second after the box is fully drawn.** No key
  approves, so a key you were already pressing, or a program typing for you, cannot say yes. The pointer must also have
  moved over Allow after that second.
- **Esc always means Deny.**
- **One box at a time.** If you say no (or do not answer) three times within 10 minutes, Omacommand pauses all agent
  requests for 10 minutes. The box also has a button, **Deny and pause 1 hour**.
- **No box while the screen is locked** or when no screen can show it. The agent is told, and nothing runs.
- **The agent never writes the box.** It shows no agent name and no agent text. Folders are shown quoted, and a folder
  that is really a link shows where it opens.

## What the agent can see

Only what `desk_state` returns: the active workspace, and for each workspace the apps from the list that are open there
(with whether each is focused, floating or full screen). It never gets window titles, window classes, addresses, a picture
of the screen or anything about your computer.

## What Allow can and cannot prove

**What Allow proves, and what it does not.** Omacommand protects you from an AI agent whose only way to reach your desktop is
Omacommand. Such an agent can only propose steps from a fixed list, you see exactly those steps, and nothing runs until you click
Allow. Allow does not protect you from programs that already have full use of your account. If your agent can run terminal
commands, or change files outside its project, without asking you first, it can control your desktop directly, change Omacommand
itself, or even click Allow for you, and no box on the screen can stop that. For the strongest setup, let your agent use
Omacommand freely, but make it ask you before every terminal command and every file change outside its project. Omacommand
makes no network connection. It does not use sudo or pkexec.

More in [SECURITY.md](SECURITY.md).

## What it writes

Omacommand never edits your settings. It keeps a few small files of its own in `~/.local/state/omacommand`: a note that the
welcome box was shown, and a short log of requests (this session and the one before). The log holds no window titles, no
folder names and no text from the agent.

## Check which version you have

Updates follow the newest version on GitHub. To see the exact version you have added:

```bash
git -C ~/.config/omarchy/plugins/io.github.lavart.omacommand rev-parse HEAD
git -C ~/.config/omarchy/plugins/io.github.lavart.omacommand log -1 --format='%H %cs %s'
```

The second line also shows the date and the title of that version. Compare it with the version listed in
[CHANGELOG.md](CHANGELOG.md). To stay on a version you have checked, run
`git -C ~/.config/omarchy/plugins/io.github.lavart.omacommand checkout --detach <sha>`. Note that `omarchy plugin update`
moves it to the newest version again.

**After an update, a reinstall or a checkout, restart the Omarchy shell** with `omarchy-restart-shell` (the top bar
restarts). Until then the shell can keep running the version it loaded before. The check in Troubleshooting tells you
when the version that runs is not the one installed.

## Remove it

```bash
omarchy plugin remove io.github.lavart.omacommand
claude mcp remove --scope user omacommand
rm -r ~/.local/state/omacommand
```

The first line removes the plugin. The second disconnects Claude Code. The third deletes Omacommand's small log and its
"welcome already shown" note.

## Troubleshooting

- **Check everything at once:**
  `/usr/bin/ruby --disable=gems,rubyopt ~/.config/omarchy/plugins/io.github.lavart.omacommand/mcp/server.rb --check`
  - It prints one line per check: `OK`, or `FIX` with the exact command to run.
  - It covers Ruby, `OMARCHY_PATH` (set in a terminal of your Omarchy desktop, often not over SSH), the plugin being
    enabled, the Omarchy shell running, the installed version and whether the shell runs that version, and whether
    Omacommand's files were changed after they were added. It says so when it could not check something. Add `--log` to see the last 20 lines of the log.
  - It never proposes anything and never opens a box.
- **No box appears.** Run the check above. Most often the plugin is not enabled
  (`omarchy plugin enable io.github.lavart.omacommand`).
- **The agent says it has no Omacommand tools.** Restart the agent. In Claude Code, `claude mcp list` should show
  `omacommand`.
- **The agent says Omacommand is paused.** You said no several times in a row. Wait for the time it names, or carry on
  without it.
- **An app was opened but the request failed.** Apps are found by their window class. If your terminal or browser is an
  unusual one, the window may not be recognised in time, and the step reports that the app did not open.
- **"Spotify is not installed."** Omacommand looks for `/usr/bin/spotify` before it shows the box, and never adds software.
  Add Spotify yourself, the way you add other programs on Omarchy, then ask again.
- **A folder step is refused as "not in the home folder", but it is.** If your home folder is itself a link (for example
  `/home/you` points to another disk), folder steps are refused on purpose: the real place of the folder is then outside the
  home folder as Omacommand knows it.
- **A layout step says the layout could not be read, or is not the one asked for.** Omacommand asks Hyprland for the layout
  before and after, and reports a mismatch instead of "done". Try again; if it keeps failing, Hyprland did not answer.

## Questions

- **Does it need the internet or an account?** No. Everything stays on this computer.
- **Can the agent see my screen?** No. See "What the agent can see".
- **Is this the same as Omarchy's Agents icon?** No. Omarchy's own Agents icon shows your AI subscriptions and their
  limits. Omacommand only adds the Allow / Deny box for desktop steps. Use both.
- **Other tools let agents control Hyprland directly. Why this one?** Omacommand is for when you want to see and approve
  every step: a fixed list, and nothing runs without your click.

## Needs

All of these come with Omarchy 4:
- Omarchy 4.x (its shell and `omarchy-shell`). Tried on 4.0.4.
- Hyprland 0.56 (with the Lua configuration) and Quickshell 0.3.
- Ruby 3.
- git, to check the version.
- wl-clipboard, for the Copy button.
- uwsm, which starts the apps the way Omarchy does.

## For developers

The tests need Node 22 or newer and nothing else. Run `node --test` in the repository root. The tests for the MCP server
need Ruby 3 and are skipped with a message when it is not found. `node scripts/build_tools.mjs` writes `mcp/tools.json`
from `vocab.js`; a test fails when the two differ.

`vocab.js` is the only place that knows the steps. `box_model.js` holds the rules of the box and of one request. They are
plain scripts, so the shell and the tests load the same bytes.

## License

MIT. Copyright (c) 2026 lAvArt.
