# opencode-subchat

Talk to OpenCode subagents without leaving the session you are in.

OpenCode 2 already surfaces subagent children: the footer shows `N subagents`, `down` opens a live
inspector of each child's transcript, and when you are inside a child `up` walks back to its parent.
What it does not do is let you move **into** a child — so a subagent's session ID has to be looked up
by hand (`opencode api get /api/session | … filter parentID …`) and opened in another window.

This plugin adds exactly that and nothing else.

## What you get

| Trigger | Effect |
| --- | --- |
| `ctrl+y`, `/children`, or the palette entry **Go to subagent** | Opens a searchable list of this session's subagents. Picking one navigates to it, so your next message goes to that subagent. |
| `ctrl+o` inside the picker | Sends a single message to the chosen subagent without leaving the current view. Delivered with `delivery: "steer"`, so it lands at the next boundary of a running turn. |
| Prompt footer | While the composer targets a child, a small `subagent of <parent> · up to parent` badge appears. Absent otherwise. |

Nested subagents are labelled (`nested` category, `depth N` in the description).

`up` is the built-in **Go to parent session**, so moving in and back out both work.

## Install

It is a TUI-only plugin, so it belongs in `cli.json`, not `opencode.json` — it never loads on the
server, the web client, the desktop app, or ACP, and it stays active against a remote server.

```jsonc title="~/.config/opencode/cli.json"
{
  "plugins": ["github:DiyarD/opencode-subchat"]
}
```

Or clone it and point at the directory. A local directory plugin is resolved as `<dir>/tui`, which is
why `tui.tsx` sits at the repository root; the `exports` map keeps GitHub and npm installs working.

```jsonc
{
  "plugins": ["/absolute/path/to/opencode-subchat"]
}
```

Restart the TUI after changing `cli.json`.

Requires OpenCode 2.0.26 or later.

## Design notes

Deliberately conservative:

- **Never navigates on its own.** No auto-switching when a subagent spawns or finishes; only a keypress moves you.
- **Does not shadow built-ins.** Defaults to `ctrl+y`, which the TUI does not otherwise use. Built-ins keep `down` for the inspector and `up` for the parent. To rebind or remove it, set `"subchat.children"` in your `keybinds`, or use `bind: false` in the plugin source.
- **Reads session state only.** The one mutation is a prompt you explicitly send. No hooks, no server config, no changes to how any session runs.
- **Fails quiet.** With no subagents the command is disabled and the badge does not render, so a normal session looks untouched.
- **Degrades instead of breaking.** A failed steer shows an error toast; it never throws into the TUI.

A server-side plugin cannot do any of this: the `session.prompt` hook cannot retarget admission, so a
hook is structurally incapable of sending your typed message to a child. The composer, router and
tabs all live in the TUI.

## Development

```sh
bun test        # 13 tests: command shape, picker contents, navigation, steer delivery, slot claim
npx tsc --noEmit
```

The tests run `setup` against a mock context, so a rename in the SDK fails there rather than in your
terminal. The badge's JSX body is not invoked by the tests because it needs a live OpenTUI renderer.

CI runs `bun test` and `tsc --noEmit` on Linux, macOS and Windows. Nothing here touches the
filesystem, the network, or the OS API, so all three behave identically.

## Compatibility

This leans on TUI plugin APIs (`keymap.layer`, `ui.slot`, `ui.router`, `data.session.family`) that are
documented but have moved between OpenCode versions. It is verified against **2.0.26**. If a later
release renames something, the command will simply stop appearing rather than break your session — and
the tests fail loudly, since they exercise `setup` against the real SDK types.

Open an issue with your version if the plugin stops loading. The TUI's own plugins dialog reports a
failed plugin; `/plugins` then `space` shows the error.

## License

MIT