# opencode-subchat

Talk to OpenCode subagents without leaving the session you are in.

OpenCode 2 already surfaces subagent children: the footer shows `N subagents`, `down` opens a live
inspector of each child's transcript, and when you are inside a child `up` walks back to its parent.
What it does not do is let you move **into** a child, or address one from the composer without
hunting for its session ID by hand.

This plugin adds exactly that and nothing else.

## What you get

| Trigger | Effect |
| --- | --- |
| `/subagent ` in the composer | An inline list appears above the text area showing **session titles** (running chats first). Keep typing to filter it; `↑`/`↓` move the highlight, and **Tab** or a click inserts that subagent's **session ID** in place of your query. Finish the line with your message and press Enter — e.g. `/subagent ses_abc hey bro what's up!` — and the message is steered to that session. |
| `ctrl+y` or `/children` | Searchable modal picker split into **Running chats** and **Idle chats** headings; search filters both and keeps running chats on top. Enter navigates to the subagent; `ctrl+o` steers one message without switching. |
| Prompt footer | While the composer targets a child, a small `subagent of <parent> · up to parent` badge appears. Absent otherwise. |

Messages are delivered with `delivery: "steer"`, so they land at the next boundary of a running
turn. Nested subagents are labelled (`depth N`).

`up` is the built-in **Go to parent session**, so moving into a child and back out both work.

## How the inline list works (and its one limitation)

OpenCode's own slash/file autocomplete is an **internal** component. The plugin SDK only exposes
`slash: { name, aliases, arguments }` for commands — there is no supported API to register custom
argument suggestions, to read the prompt text, or to insert text into the composer. OpenCode's
fuzzy filtering (`fuzzysort`) is internal too, so this plugin uses simple, fast substring filtering
instead, as intended.

The inline list is therefore built from public APIs: it renders into the `session.composer.top`
slot and uses OpenTUI's `renderer.currentFocusedEditor` (`plainText`, `onContentChange`,
`deleteRange`, `insertText`) to follow what you type and insert the chosen session ID. It follows
OpenCode's autocomplete conventions (bordered popup, highlighted row, mouse selection), wraps the
host's `onContentChange` rather than replacing it, and releases its timer, handler and keymap layer
when the slot unmounts. If no textarea is focused, it is a no-op.

The `session.composer.top` slot and `currentFocusedEditor` are available in the OpenCode 2.0.26 /
OpenTUI 0.6.x line this plugin targets. On a build where they are missing, the inline list simply
does not appear; the `/subagent <id> <message>` command and the modal picker still work.

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

- **Never navigates on its own.** Only `/children` (Enter) moves you; steering and the inline list do not.
- **Does not shadow built-ins.** `ctrl+y` is free in the TUI; built-ins keep `down` for the inspector and `up` for the parent. The inline list only claims `tab` while it is visible.
- **Reads session state only.** The one mutation is a prompt you explicitly send. No hooks, no server config, no changes to how any session runs.
- **Fails quiet.** With no subagents the commands are disabled, the inline list is not mounted, and the badge does not render — a normal session looks untouched.
- **Degrades instead of breaking.** A failed steer shows an error toast; it never throws into the TUI.

A server-side plugin cannot do any of this: the `session.prompt` hook cannot retarget admission, so a
hook is structurally incapable of sending your typed message to a child. The composer, router and
tabs all live in the TUI.

## Development

```sh
bun test        # 20 tests: command shapes, picker contents/search, navigation, steer delivery, direct sends, slot claims
npx tsc --noEmit
```

The tests run `setup` against a mock context, so a rename in the SDK fails there rather than in your
terminal. The JSX bodies (footer badge and inline list) are not invoked by the tests because they
need a live OpenTUI renderer; only the shape of their slot claims is asserted.

CI runs `bun test` and `tsc --noEmit` on Linux, macOS and Windows.

## Compatibility

This leans on TUI plugin APIs (`keymap.layer`, `ui.slot`, `ui.router`, `data.session.family`) and on
OpenTUI's focused-editor API. They are documented but have moved between OpenCode versions. It is
verified against **2.0.26** and the current 2.3.x SDK types (which are identical for the TUI context).
If a later release renames something, the command will stop appearing rather than break your session —
and the tests fail loudly, since they exercise `setup` against the real SDK types.

Open an issue with your version if the plugin stops loading. The TUI's own plugins dialog reports a
failed plugin; `/plugins` then `space` shows the error.

## License

MIT
