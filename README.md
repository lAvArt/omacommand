# Omacommand

Let your AI agent arrange your Omarchy desktop. The agent suggests the steps, you see them in a box, and nothing happens
until you click **Allow**.

Say you're working with Claude Code and want VS Code and the browser side by side on workspace 2. Instead of doing it by
hand, you just ask:

> Put VS Code and the browser side by side on workspace 2.

The agent can't touch your desktop on its own. Through Omacommand it can only suggest steps from a fixed list, and a box
pops up in the middle of your screen:

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

Click **Allow** and exactly those steps run, and the agent hears back how each one went. Click **Deny**, press **Esc**,
or leave the box alone for 45 seconds, and nothing happens. The agent is told you said no.

## Why you can trust the box

- **The agent picks from a short menu** (see [What you can ask for](#what-you-can-ask-for)). It can't send its own
  commands, web addresses or text.
- **What you read is what runs.** Omacommand writes the box itself, from that menu. The agent doesn't get a word in.
- **Nothing leaves your computer.** There's no internet connection, no account and no open port. The agent and
  Omacommand talk to each other right here on this machine.
- **Some things just aren't on the menu:** shutting down or restarting, installing or removing software, taking
  screenshots, and anything that needs your password.
- **It behaves like your own keys.** Each step does only what Omarchy's own keys do, including the state they keep. Turn on
  the night light, change the gaps or switch the layout, and it's remembered exactly as if you'd pressed the key yourself.
  Omacommand never edits your settings.

## Get started

You need Omarchy 4 or newer, and that's it. Ruby comes with every Omarchy install.

**Step 1: add the plugin.** Open a terminal and run:

```bash
omarchy plugin add https://github.com/lAvArt/omacommand --enable
```

Omarchy reminds you that plugins run with your user's rights and asks you to confirm. Say yes. A welcome box then appears
with the command for the next step and a **Copy** button.

**Step 2: connect your agent.** For Claude Code, run this once (or paste it from the welcome box), then restart Claude
Code:

```bash
claude mcp add --scope user omacommand -- /usr/bin/ruby --disable=gems,rubyopt ~/.config/omarchy/plugins/io.github.lavart.omacommand/mcp/server.rb
```

**Try it.** Ask your agent to *"Go to workspace 2."* If the box shows up, you're all set.

There is nothing else to download. No keys to create, and no config files to edit by hand.

<details>
<summary>Using another agent (any app that supports MCP)</summary>

Add this to the agent's MCP settings, with `YOU` replaced by your user name:

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

Your agent gets three tools:
- `propose_desk_plan` asks to run 1 to 12 steps;
- `desk_plan_result` picks up the result of a run that was still going after about 50 seconds;
- `desk_state` tells it the active workspace and which apps from the list are open on which workspace.

Claude Code may ask you before each tool call. It's fine to always allow Omacommand's three tools, because the box asks
you again anyway. Don't allow terminal commands across the board, though (the section on what Allow can prove explains
why).
</details>

## What you can ask for

- **Workspaces:** jump to any workspace from 1 to 10, or move a window to another one.
- **Apps:** open the terminal, browser, file manager, VS Code, Obsidian, Spotify or btop. The terminal, file manager and
  VS Code can start in a folder inside your home folder. Any app can open to the left, right, above or below the current
  window. Opening beside a window needs the tiled layout (the default); in the scrolling layout the new window may land
  somewhere else.
- **Windows:** focus, swap, resize, float, full screen, full width, pop out, toggle the split, group into tabs, pin,
  center, change the transparency, or tuck a window away in the scratchpad.
- **Layouts:** tile the windows on a workspace, or line them up in a scrolling row.
- **Everyday things:** volume, brightness, play and pause, next and previous track, night light, gaps between windows,
  locking the screen, and a quick notification with the time or the battery level.
- **Closing a window,** one at a time. The box names the exact window (the app and its workspace) and warns you that
  unsaved work in it could be lost.

One request can hold up to 12 steps, and every step uses the same Omarchy command its key would run. Volume, brightness
and music steps are waited for: if one of them fails, the agent is told, and the steps after it don't run.

Spotify has to be on your computer already. Omacommand never adds software, and it tells the agent when Spotify is
missing.

## The box, up close

The box is built so that only you, with a mouse or a touch screen, can say yes.

- **Allow only answers to a click or a tap.** It becomes clickable one second after the box is fully drawn, and only once
  you've moved the pointer over it after that second. No key approves, so a key you were already holding down, or a
  program typing for you, can't slip a yes through.
- **Esc always means Deny.**
- **One box at a time.** If you say no (or don't answer) three times within 10 minutes, Omacommand pauses all agent
  requests for 10 minutes. For a longer break, there's a **Deny and pause 1 hour** button.
- **No box while your screen is locked,** or when there's no screen to show it on. The agent is told, and nothing runs.
- **The agent can't write in the box.** It shows no agent name and none of the agent's text. Folder names are shown in
  quotes, and if a folder is really a link, the box shows where it leads.

## What the agent can see

Only what `desk_state` gives it: which workspace is active and, for each workspace, which apps from the list are open
there (and whether each one is focused, floating or full screen). It never gets window titles, window classes, addresses
or a picture of your screen, and it learns nothing else about your computer.

## What Allow can and can't prove

A box on the screen is only as strong as the rest of your agent's setup, so here's the honest version:

**What Allow proves, and what it does not.** Omacommand protects you from an AI agent whose only way to reach your desktop is
Omacommand. Such an agent can only propose steps from a fixed list, you see exactly those steps, and nothing runs until you click
Allow. Allow does not protect you from programs that already have full use of your account. If your agent can run terminal
commands, or change files outside its project, without asking you first, it can control your desktop directly, change Omacommand
itself, or even click Allow for you, and no box on the screen can stop that. For the strongest setup, let your agent use
Omacommand freely, but make it ask you before every terminal command and every file change outside its project. Omacommand
makes no network connection. It does not use sudo or pkexec.

There's more detail in [SECURITY.md](SECURITY.md).

## What it writes

Omacommand never edits your settings. It keeps a few small files of its own in `~/.local/state/omacommand`: a note that the
welcome box was shown, and a short log of requests (this session and the one before). The log never holds window titles,
folder names or anything the agent wrote.

## Check which version you have

Omacommand updates from the newest version on GitHub. To see exactly which version you have:

```bash
git -C ~/.config/omarchy/plugins/io.github.lavart.omacommand rev-parse HEAD
git -C ~/.config/omarchy/plugins/io.github.lavart.omacommand log -1 --format='%H %cs %s'
```

The second line also shows the date and the title of that version, so you can compare it with
[CHANGELOG.md](CHANGELOG.md). To stay on a version you've checked, run
`git -C ~/.config/omarchy/plugins/io.github.lavart.omacommand checkout --detach <sha>`. Keep in mind that
`omarchy plugin update` moves you to the newest version again.

**After an update, a reinstall or a checkout, restart the Omarchy shell** with `omarchy-restart-shell` (your top bar
restarts with it). Until you do, the shell can keep running the version it loaded before. The check under
[Troubleshooting](#troubleshooting) tells you when the version that's running isn't the one you installed.

## Remove it

```bash
omarchy plugin remove io.github.lavart.omacommand
claude mcp remove --scope user omacommand
rm -r ~/.local/state/omacommand
```

The first line removes the plugin, the second disconnects Claude Code, and the third deletes Omacommand's small log and its
"welcome already shown" note.

## Troubleshooting

**Start with the built-in check.** It looks at everything at once:

```bash
/usr/bin/ruby --disable=gems,rubyopt ~/.config/omarchy/plugins/io.github.lavart.omacommand/mcp/server.rb --check
```

You get one line per check: `OK`, or `FIX` followed by the exact command to run. It covers Ruby, `OMARCHY_PATH` (set in a
terminal on your Omarchy desktop, but often not over SSH), whether the plugin is enabled, whether the Omarchy shell is
running, the installed version and whether the shell is running that version, and whether Omacommand's files were changed
after you added them. If it couldn't check something, it says so. Add `--log` to see the last 20 lines of the log. The
check never proposes anything and never opens a box.

- **No box appears.** Run the check. Most of the time the plugin just isn't enabled:
  `omarchy plugin enable io.github.lavart.omacommand`.
- **The agent says it has no Omacommand tools.** Restart the agent. In Claude Code, `claude mcp list` should show
  `omacommand`.
- **The agent says Omacommand is paused.** You said no a few times in a row. Wait for the time it mentions, or carry on
  without it.
- **An app opened, but the step still failed.** Omacommand recognises apps by their window class. With an unusual
  terminal or browser, the window may not be recognised in time, and the step reports that the app didn't open.
- **"Spotify is not installed."** Omacommand looks for `/usr/bin/spotify` before it shows the box, and never adds
  software. Add Spotify the way you add any other program on Omarchy, then ask again.
- **A folder step is refused as "not in the home folder", but it is.** If your home folder is itself a link (for example,
  `/home/you` points to another disk), folder steps are refused on purpose: the folder's real location is then outside the
  home folder as Omacommand knows it.
- **A layout step says the layout couldn't be read, or isn't the one you asked for.** Omacommand asks Hyprland for the
  layout before and after the change, and reports a mismatch instead of claiming it worked. Try again. If it keeps
  happening, Hyprland isn't answering.

## Questions

- **Does it need the internet or an account?** No. Everything stays on your computer.
- **Can the agent see my screen?** No. See [What the agent can see](#what-the-agent-can-see).
- **Is this the same as Omarchy's Agents icon?** No. That icon shows your AI subscriptions and their limits. Omacommand
  only adds the Allow / Deny box for desktop steps. The two work fine side by side.
- **Other tools let agents control Hyprland directly. Why use this one?** Because here you see and approve every single
  step. The list is fixed, and nothing runs without your click.

## Requirements

Everything here comes with Omarchy 4:
- Omarchy 4.x, with its shell and `omarchy-shell` (tested on 4.0.4);
- Hyprland 0.56 with the Lua configuration, and Quickshell 0.3;
- Ruby 3;
- git, to check which version you have;
- wl-clipboard, for the Copy button;
- uwsm, which starts apps the same way Omarchy does.

## For developers

The tests need Node 22 or newer and nothing else: run `node --test` in the repository root. The MCP server's tests also
need Ruby 3, and they're skipped with a message when Ruby isn't found. `node scripts/build_tools.mjs` writes
`mcp/tools.json` from `vocab.js`, and a test fails if the two drift apart.

`vocab.js` is the only place that knows the steps, and `box_model.js` holds the rules for the box and for a single
request. Both are plain scripts, so the shell and the tests load exactly the same bytes.

## License

MIT. Copyright (c) 2026 lAvArt.
