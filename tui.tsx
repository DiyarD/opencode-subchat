/** @jsxImportSource @opentui/solid */
import { Plugin, usePlugin } from "@opencode/plugin/tui"
import { measureEditText, type EditBufferRenderable, type ScrollBoxRenderable } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/solid"
import { createEffect, createMemo, createSignal, Index, onCleanup, onMount, Show } from "solid-js"

/**
 * opencode-subchat — talk to subagents without leaving the session you are in.
 *
 * OpenCode 2 already tracks subagent children: the footer shows "N subagents" and `down`
 * opens a live inspector of each child's transcript. What it does not do is let you move *into*
 * a child, or address one from the composer without hunting for its session ID. This plugin
 * fills exactly that gap and nothing else.
 *
 *   /subagent <query><tab>  inline list above the composer shows subagent titles (running
 *                           first); Tab / click inserts that subagent's session ID. Finish
 *                           with your message and press Enter to steer it to that session.
 *   ctrl+y, /children        searchable picker, split into "Running chats" and "Idle chats".
 *                           Enter navigates; ctrl+o steers one message without switching.
 *   prompt footer           a badge naming the parent while you are typing into a child
 *
 * The inline list uses OpenTUI's public focused-editor API (plainText / insertText /
 * onContentChange) because OpenCode's own autocomplete is internal and not exposed to
 * plugins. Everything it touches is released in onCleanup, and it degrades to a no-op if no
 * textarea is focused. Built-in bindings keep down/up; the only new binding is `tab` while
 * the list is visible.
 */

const MAX_TITLE = 40
const MAX_ROWS = 10
/** Matches `/subagent <query>` while the query is still one token. */
const INLINE = /^\/subagent[ \t]+([^\s]*)$/

function truncate(value: string, max = MAX_TITLE) {
  const clean = value.replace(/\s+/g, " ").trim()
  return clean.length <= max ? clean : `${clean.slice(0, max - 1)}…`
}

type Subagent = {
  readonly id: string
  readonly title: string
  readonly running: boolean
  readonly depth: number
}

/** Descendant sessions of a root, deepest last, in stable title order. */
function descendants(context: Plugin.Context, sessionID: string) {
  return context.data.session
    .family(sessionID)
    .filter((id) => id !== sessionID)
    .map((id) => context.data.session.get(id))
    .filter((session): session is NonNullable<typeof session> => session !== undefined)
    .toSorted((left, right) => (left.title ?? left.id).localeCompare(right.title ?? right.id))
}

/** Levels below `root`: a direct child is 1, a grandchild 2. Bounded against a cycle. */
function depthOf(context: Plugin.Context, sessionID: string, root: string) {
  let depth = 0
  let cursor = sessionID
  while (cursor !== root && depth < 32) {
    const parent = context.data.session.get(cursor)?.parentID
    if (!parent) return depth
    cursor = parent
    depth++
  }
  return depth
}

/** Running first, then by title. Used by the inline list, the modal search, and name resolution. */
function rank(left: Subagent, right: Subagent) {
  return Number(right.running) - Number(left.running) || left.title.localeCompare(right.title)
}

function subagentsOf(context: Plugin.Context, root: string): Subagent[] {
  return descendants(context, root).map((session) => ({
    id: session.id,
    title: truncate(session.title ?? session.id),
    running: context.data.session.status(session.id) === "running",
    depth: depthOf(context, session.id, root),
  }))
}

/**
 * Inline subagent autocomplete, following OpenCode's own Autocomplete component closely:
 * an absolutely-positioned popup, `focused_editor` events instead of polling, the
 * `autocomplete` mode + native keybind conventions, `<Index>` rows, hover/click selection
 * and native selection colours. It uses OpenTUI's public focused-editor API because OC's
 * autocomplete is internal and not exposed to plugins. Everything is released on dispose.
 */
function SubagentPicker(props: { sessionID: string }) {
  const context = usePlugin()
  const { renderer, theme, keymap } = context
  const dimensions = useTerminalDimensions()

  const [query, setQuery] = createSignal("")
  const [visible, setVisible] = createSignal(false)
  const [selected, setSelected] = createSignal(0)
  const [dismissed, setDismissed] = createSignal<string>()

  let editor: EditBufferRenderable | undefined
  let scroll: ScrollBoxRenderable | undefined
  let previousChange: EditBufferRenderable["onContentChange"]
  let bound = false

  const options = createMemo<Subagent[]>(() => {
    const needle = query().trim().toLowerCase()
    return subagentsOf(context, props.sessionID)
      .filter((item) => !needle || item.title.toLowerCase().includes(needle) || item.id.toLowerCase().includes(needle))
      .toSorted((left, right) => rank(left, right))
      .slice(0, MAX_ROWS)
  })

  const listHeight = createMemo(() =>
    Math.min(MAX_ROWS, Math.max(1, options().length || 1), Math.max(1, dimensions().height - 10)),
  )

  const sync = (current: EditBufferRenderable) => {
    const text = current.plainText
    if (dismissed() === text) return
    const match = INLINE.exec(text)
    if (!match) {
      if (visible()) hide(false)
      return
    }
    const next = match[1] ?? ""
    if (next !== query()) {
      setQuery(next)
      setSelected(0)
    }
    if (!visible()) setVisible(true)
  }

  const hide = (remember = true) => {
    if (remember) setDismissed(editor?.plainText)
    setVisible(false)
    setQuery("")
  }

  // Wrap, never replace: the host's own onContentChange keeps syncing the prompt store.
  const bind = (next: EditBufferRenderable) => {
    if (next === editor && bound) return
    unbind()
    editor = next
    previousChange = next.onContentChange
    next.onContentChange = ((event: Parameters<NonNullable<EditBufferRenderable["onContentChange"]>>[0]) => {
      previousChange?.(event)
      sync(next)
    }) as EditBufferRenderable["onContentChange"]
    bound = true
    sync(next)
  }

  const unbind = () => {
    if (editor && bound) editor.onContentChange = previousChange
    editor = undefined
    previousChange = undefined
    bound = false
  }

  const insert = (index: number) => {
    const choice = options()[index]
    const current = editor
    if (!choice || !current) return
    const text = current.plainText
    const match = INLINE.exec(text)
    if (!match) {
      hide(false)
      return
    }
    // The query is one token at the end of the text; deleteRange uses display columns.
    const width = (value: string) => measureEditText(value, { widthMethod: renderer.widthMethod })
    const end = width(text)
    current.deleteRange(0, end - width(match[1] ?? ""), 0, end)
    current.insertText(`${choice.id} `)
    hide(false)
  }

  const move = (delta: number) => {
    const count = options().length
    if (count === 0) return
    setSelected((current) => (current + delta + count) % count)
  }

  onMount(() => {
    // Native uses a focused-editor event; no timer is needed to track which editor we follow.
    // The SDK's renderer type omits EventEmitter, though the runtime renderer implements it.
    const events = renderer as unknown as {
      on(event: string, listener: (next: EditBufferRenderable | null) => void): void
      off(event: string, listener: (next: EditBufferRenderable | null) => void): void
    }
    const onFocus = (next: EditBufferRenderable | null) => {
      if (next) bind(next)
    }
    events.on("focused_editor", onFocus)
    const current = renderer.currentFocusedEditor
    if (current) bind(current)
    onCleanup(() => {
      events.off("focused_editor", onFocus)
      unbind()
    })
  })

  // Keep the highlighted row in view as it moves.
  createEffect(() => {
    const index = selected()
    const id = `subchat.row.${index}`
    if (!scroll?.getRenderable(id)) return
    scroll.scrollChildIntoView(id)
  })

  // Only claim navigation keys while the list is actually visible. A permanently registered
  // high-priority layer would shadow OpenCode's own up/down/tab/escape bindings everywhere.
  keymap.layer(() => ({
    mode: "global",
    priority: 10,
    enabled: () => visible(),
    commands: [
      { id: "subchat.picker.prev", title: "Previous subagent", group: "Autocomplete", bind: "up", run: () => move(-1) },
      { id: "subchat.picker.next", title: "Next subagent", group: "Autocomplete", bind: "down", run: () => move(1) },
      { id: "subchat.picker.hide", title: "Hide subagents", group: "Autocomplete", bind: "escape", run: () => hide() },
      { id: "subchat.picker.insert", title: "Insert subagent id", group: "Autocomplete", bind: "tab", run: () => insert(selected()) },
    ],
  }))

  return (
    <Show when={visible()}>
      <box flexDirection="column" flexShrink={0} border borderColor={theme.border.base}>
        <scrollbox ref={scroll} height={listHeight()} scrollbarOptions={{ visible: false }}>
        <Index
          each={options()}
          fallback={
            <box paddingLeft={1} paddingRight={1}>
              <text fg={theme.text.muted} wrapMode="none">
                no matching subagents
              </text>
            </box>
          }
        >
          {(option, index) => (
            <box
              id={`subchat.row.${index}`}
              paddingLeft={1}
              paddingRight={1}
              flexDirection="row"
              backgroundColor={index === selected() ? theme.background.action.primary.focused : undefined}
              onMouseMove={() => setSelected(index)}
              onMouseDown={() => setSelected(index)}
              onMouseUp={() => insert(index)}
            >
              <text
                fg={index === selected() ? theme.text.action.primary.focused : theme.text.base}
                wrapMode="none"
                flexShrink={0}
              >
                {option().title}
              </text>
              <text fg={index === selected() ? theme.text.action.primary.focused : theme.text.muted} wrapMode="none">
                {` ${option().running ? "running" : "idle"}${option().depth > 1 ? ` · depth ${option().depth}` : ""}`}
              </text>
            </box>
          )}
        </Index>
        </scrollbox>
      </box>
    </Show>
  )
}
export default Plugin.define({
  id: "opencode-subchat",
  setup(context) {
    const { client, data, keymap, ui } = context

    const steer = async (sessionID: string, text: string) => {
      const session = data.session.get(sessionID)
      try {
        await client.session.prompt({ sessionID, text, delivery: "steer" })
        ui.toast.show({
          title: "Steered",
          message: `Message delivered to ${truncate(session?.title ?? sessionID, 28)}`,
          sessionID,
          variant: "success",
          duration: 3000,
        })
      } catch (cause) {
        ui.toast.show({
          title: "Steer failed",
          message: cause instanceof Error ? cause.message : String(cause),
          variant: "error",
          duration: 6000,
        })
      }
    }

    const rootOf = () => {
      const route = ui.router.current()
      return route.type === "session" ? route.sessionID : undefined
    }

    const resolve = (candidates: Subagent[], token: string) => {
      const needle = token.toLowerCase()
      return candidates
        .filter(
          (item) =>
            item.id.toLowerCase() === needle ||
            item.title.toLowerCase() === needle ||
            item.title.toLowerCase().includes(needle) ||
            item.id.toLowerCase().includes(needle),
        )
        .toSorted((left, right) => rank(left, right))[0]
    }

    /** `/subagent <id-or-title> <message>` — the whole point of the inline picker. */
    const send = async (input: string | undefined) => {
      const root = rootOf()
      if (!root) {
        ui.toast.show({ message: "Open a session first", variant: "warning" })
        return
      }
      const words = (input ?? "").trim().split(/\s+/).filter(Boolean)
      if (words.length === 0) {
        await openPicker()
        return
      }
      // Titles can be several words, so consume the longest prefix that resolves to a
      // subagent and treat the remainder as the message.
      const candidates = subagentsOf(context, root)
      let chosen: Subagent | undefined
      let consumed = 0
      for (let count = Math.min(4, words.length); count >= 1; count--) {
        const match = resolve(candidates, words.slice(0, count).join(" "))
        if (match) {
          chosen = match
          consumed = count
          break
        }
      }
      if (!chosen) {
        ui.toast.show({ message: `No subagent matching "${truncate(words[0] ?? "", 24)}"`, variant: "warning" })
        return
      }
      const message = words.slice(consumed).join(" ").trim()
      if (!message) {
        ui.toast.show({ message: "Add a message after the subagent", variant: "warning" })
        return
      }
      await steer(chosen.id, message)
    }

    /** The modal picker, kept for browsing/navigating with a clear Running / Idle split. */
    const openPicker = async () => {
      const root = rootOf()
      if (!root) {
        ui.toast.show({ message: "Open a session first", variant: "warning" })
        return
      }
      const children = descendants(context, root)
      if (children.length === 0) {
        ui.toast.show({ message: "No subagents in this session", variant: "info" })
        return
      }

      // No custom `search`: OpenCode flattens results and drops category headings when one is
      // supplied. Its built-in search filters and keeps the two section headings intact.
      const options = subagentsOf(context, root)
        .toSorted((left, right) => rank(left, right))
        .map((item) => ({
          title: item.title,
          value: item.id,
          description: item.depth > 1 ? `depth ${item.depth}` : undefined,
          category: item.running ? "Running chats" : "Idle chats",
        }))

      const chosen = await ui.dialog.select({
        title: children.length === 1 ? "Subagent" : `Subagents (${children.length})`,
        current: root,
        options,
        actions: [
          {
            bind: "ctrl+o",
            title: "Steer...",
            side: "right" as const,
            onTrigger: async (sessionID) => {
              const text = await ui.dialog.prompt({
                title: `Steer ${truncate(data.session.get(String(sessionID))?.title ?? String(sessionID), 28)}`,
                placeholder: "Message to send to the running subagent",
              })
              if (text?.trim()) await steer(String(sessionID), text.trim())
            },
          },
        ],
      })
      if (!chosen) return

      // The composer follows the route, so navigating is the whole switch.
      ui.router.navigate({ type: "session", sessionID: String(chosen) })
    }

    keymap.layer(() => ({
      mode: "global",
      priority: 10,
      commands: [
        {
          id: "subchat.children",
          title: "Go to subagent",
          description: "Browse running and idle subagents",
          group: "Session",
          palette: true,
          slash: { name: "children" },
          // Free in the TUI; ctrl+g and ctrl+alt+g belong to session.first / session.last.
          bind: "ctrl+y",
          suggested: () => {
            const route = ui.router.current()
            return route.type === "session" && descendants(context, route.sessionID).length > 0
          },
          enabled: () => {
            const route = ui.router.current()
            return route.type === "session" && descendants(context, route.sessionID).length > 0
          },
          run: () => openPicker(),
        },
        {
          id: "subchat.send",
          title: "Message a subagent",
          description: "Type a title, press tab, then your message — Enter steers it",
          group: "Session",
          palette: true,
          slash: { name: "subagent", arguments: true },
          enabled: () => {
            const route = ui.router.current()
            return route.type === "session" && descendants(context, route.sessionID).length > 0
          },
          suggested: () => {
            const route = ui.router.current()
            return route.type === "session" && descendants(context, route.sessionID).length > 0
          },
          run: (input) => send(input),
        },
      ],
    }))

    // Names the parent only while the composer targets a child, so the badge is absent in
    // the common case instead of adding permanent chrome to the footer.
    ui.slot({
      append: "prompt.footer.status",
      render: () => {
        const route = ui.router.current()
        const child = route.type === "session" ? data.session.get(route.sessionID) : undefined
        const parentID = child?.parentID
        const parent = parentID ? data.session.get(parentID) : undefined
        return (
          <Show when={parentID && parent} keyed>
            <text fg={context.theme.text.muted} wrapMode="none" flexShrink={0}>
              subagent of {truncate(parent?.title ?? parentID ?? "", 24)} · up to parent
            </text>
          </Show>
        )
      },
    })

    // The inline list lives above the composer. Only mount it (and its listener/timer) in
    // sessions that actually have subagents, so a normal session stays untouched.
    ui.slot({
      append: "session.composer.top",
      render: (input) => (
        <Show when={descendants(context, input.sessionID).length > 0}>
          <SubagentPicker sessionID={input.sessionID} />
        </Show>
      ),
    })
  },
})
