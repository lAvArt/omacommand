# Changelog

Omacommand follows the newest commit on GitHub, so every release lists the full commit it was made from. Compare it with
the commit you have (see "Check which version you have" in the [README](README.md)).

Each entry has:
- the version and the date;
- the full 40-character SHA of the release commit (added in the next commit, because a commit cannot hold its own SHA);
- the signed tag;
- the marketplace verification issue;
- what changed, in plain words;
- a "Security" line for every change that matters for safety.

## 1.0.0 - 2026-10-11

- **Commit:** to be added after the release commit.
- **Tag:** `v1.0.0` (signed).
- **Marketplace verification issue:** to be added after the listing.
- **What changed:** the first release.
  - An AI agent can propose up to 12 desktop steps from a fixed list: workspaces, seven apps, window actions, layouts, the
    scratchpad, night light, gaps, lock, volume, brightness, music and a time or battery notice.
  - A box on the screen shows exactly those steps. Nothing runs until the person clicks Allow.
  - A small MCP server (`mcp/server.rb`, Ruby standard library only) gives agents three tools: `propose_desk_plan`,
    `desk_plan_result` and `desk_state`.
  - A one-time welcome note shows the connect command with a Copy button.
  - `mcp/server.rb --check` checks the whole setup in plain words.
- **Code review before the release:** a review of the code found one serious problem and seventeen smaller ones. All of them
  are fixed in 1.0.0:
  - Allow could stay grey until the first click on a real machine, because the first keyboard focus threw away the first
    drawn frame. Now the first focus restarts nothing; a loss of focus, and a regain after it, restart the delay, and after
    any restart the window is asked for a new frame until one arrives.
  - A button that moved under a pointer that sat still could count as pointer motion. Now only a changed position of the
    pointer on the screen counts (the first position Allow sees is only the starting point), and the box keeps its layout
    fixed while it is open.
  - "Open Spotify" no longer uses Omarchy's own launcher for it, which adds software when Spotify is missing. It starts
    Spotify directly, and the box is refused with "Spotify is not installed." when it is not there.
  - Volume, brightness and music steps run exactly the commands of Omarchy 4.0.4's own keys. They are waited for, and a
    failed one is reported instead of "done".
  - Layout steps ask Hyprland for the layout before they read it and after they change it, and report a layout that is not
    the one asked for. A layout that cannot be read is not toggled blind.
  - An internal error now ends the open request and closes its box. A process that never started, or was stopped before it
    started, frees its slot at once instead of blocking every later request.
  - Keyboard focus is forced onto the box each time it shows. Only the two synthesized mouse sources count as a touch.
  - One click on Allow can no longer run the steps twice, and a closed or bound window address is always remembered.
  - A window is bound for closing only when it has a real process id and a stable id.
  - The tables of commands, apps and Lua templates are frozen when the plugin loads.
  - The MCP server stops polling early enough to answer inside a 60 second client limit, and never says that nothing ran
    when the last check got no answer. `--check` says when it could not check, and when `OMARCHY_PATH` is not set.
  - The terminal list also knows foot under its second window class and its client.
  - The repository now has a `.gitattributes` file for LF line endings.
- **Pilot on a real machine before the release:**
  - The box and the welcome note now wear the shell's theme, as Omarchy's own dialogs do: its colours, its monospace font
    and type sizes, square buttons with thin borders, and Hyprland's corner rounding. Allow takes the theme's accent once
    it is ready. Small text no longer uses the theme's "muted" colour, which some themes make too dark to read.
  - "Open Obsidian" also knows the window class of newer Obsidian builds, `md.obsidian.Obsidian`. Before, it waited and
    then reported that Obsidian did not open.
  - The MCP server frees its one-call slot before it answers, so a client's next call can no longer get a false busy answer.
  - `--check` now says when the Omarchy shell still runs another version than the one installed, and the README says to
    restart the shell after an update or a reinstall: until it restarts, the shell can keep running the code it loaded.
- **Security:**
  - The plugin is a service only. It has no panel, overlay or menu that `omarchy-shell shell call` could reach.
  - Requests arrive through the plugin's own IPC target. No request files are read.
  - Allow is a mouse or touch click only, clickable one second after the box is fully drawn. Esc or Deny means no, and so
    does no answer within 45 seconds.
  - Closing is one window at a time, bound when the box is built and named in it.
  - No network, no screenshots, no free text, no URLs, no shell or Lua from the agent.
  - An update takes effect only after the shell restarts, so a fix can stay inactive until then; `--check` reports it.
