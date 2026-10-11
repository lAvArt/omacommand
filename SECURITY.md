# Security

**What Allow proves, and what it does not.** Omacommand protects you from an AI agent whose only way to reach your desktop is
Omacommand. Such an agent can only propose steps from a fixed list, you see exactly those steps, and nothing runs until you click
Allow. Allow does not protect you from programs that already have full use of your account. If your agent can run terminal
commands, or change files outside its project, without asking you first, it can control your desktop directly, change Omacommand
itself, or even click Allow for you, and no box on the screen can stop that. For the strongest setup, let your agent use
Omacommand freely, but make it ask you before every terminal command and every file change outside its project. Omacommand
makes no network connection. It does not use sudo or pkexec.

## Report a problem

Please report a security problem through GitHub's private vulnerability reporting on this repository (the "Security" tab,
then "Report a vulnerability"). Do not open a public issue for it.

## What Omacommand is

A convenience with a consent step. It is not a security boundary against programs that already run as you.

Omacommand is an Omarchy plugin, and Omarchy plugins are not sandboxed. It runs inside `omarchy-shell`, the same process
that draws the bar, shows notifications and handles the lock screen. A bug in Omacommand is therefore a bug in that process.
That is why the code is small, every wait is a timer, every input is size-checked before it is read, and the tests feed it
hostile input.

## What it protects against

An agent whose only way to the desktop is Omacommand, including an agent that was tricked by text in a web page, a
repository or a mail:
- It can propose only the steps on the list (see the README). It cannot send commands, Lua, web addresses, file names,
  window titles or any other free text.
- The box text is written by Omacommand from that list. It shows no agent name and no agent text. A folder is shown quoted,
  and a folder that is a link shows where it really opens.
- Allow is a mouse or touch click only. It becomes clickable one second after the box is fully drawn, and the click must come
  after that. Keys never approve. Esc or Deny means no, and so does no answer within 45 seconds.
- Nothing can approve, change a shown plan, skip the delay or lengthen the timeout: not an IPC call, a file, a setting or an
  environment variable. There is no debug mode.
- A plan is checked when it arrives and again just before it runs. Lua is built only from fixed templates with checked
  values. Commands are argv lists, never a shell string.
- Closing a window is one window at a time. The window is chosen when the box is built and named in the box. If it closes,
  or another window takes its address, the request is cancelled or the step fails.
- Requests are rate limited. Repeated no answers pause everything for 10 minutes.
- The agent never sees window titles, window classes, addresses or the screen.
- There is no network use at all: no sockets, no HTTP, no open port. QML never reads a file.

## What it does not protect against

- **Programs that already run as you.** A program that can run commands as your user can use `hyprctl`, type with `wtype`,
  read the screen with `grim`, draw its own windows over the box, and click through a virtual pointer. A program that can
  write files in your account can change Omacommand (or any plugin: Omarchy reloads saved plugin files). No box can stop
  that. Make your agent ask you before it runs terminal commands or changes files outside its project.
- **A takeover of this repository.** Installing and updating follow the newest commit. Updates show a diff and ask first. See
  "Check which version you have" in the README, and the full commit in [CHANGELOG.md](CHANGELOG.md).
- **A bug that stalls the shell.** The limits and tests are there to prevent it. Nothing can promise it.

## Smaller things to know

- While a request is being sent, other users on the same computer can see the plan in the process list. Plans hold no
  secrets, but folder names are in them.
- `desk_state` tells an agent which apps from the list are open and which one is focused. An agent that asks once a second
  can learn when you switch apps. It is limited to once a second and written to the log.
- Steps run Omarchy's own commands, the same ones its keys run. They keep the state those commands keep (for example the
  night light, the gaps and the layout choice), just as the keys do.
- Opening VS Code or a terminal in a folder can start that folder's own automation, as those tools do when you open the
  folder yourself. The box names the folder.
- A window can be closed in the few milliseconds between the last check and the close. That window is the one named in the
  box.

## Optional hardening

Hyprland's permission system can stop programs from silently capturing the screen: add
`hl.config({ ecosystem = { enforce_permissions = true } })` to your own Hyprland config and restart Hyprland. It does not
stop a program that can run commands as you from controlling the desktop.

Omacommand never changes any config itself.

## What Omacommand writes

Only `~/.local/state/omacommand` (or `$XDG_STATE_HOME/omacommand`): a note that the welcome box was shown, and a short log
of requests, this session and the one before. The folder is made with mode 700. The log holds no window titles, no folder
names, no addresses and no text from the agent. The agent's own name appears only if it is plain, and is marked as
self-reported. Omacommand does not write anything in the plugin folder, your Hyprland config, `shell.json` or any agent's
settings. The connect command is one you run yourself; the welcome box only copies it.

## Checking your setup

`/usr/bin/ruby --disable=gems,rubyopt ~/.config/omarchy/plugins/io.github.lavart.omacommand/mcp/server.rb --check` prints one
line per check. It warns when Omacommand's files differ from the version you added. That is a hint, not proof.
