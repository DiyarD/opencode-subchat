/** @jsxImportSource @opentui/solid */
import { Plugin } from "@opencode/plugin/tui"
import { Show } from "solid-js"

/**
 * opencode-subchat — talk to subagents without leaving the session you are in.
 *
 * OpenCode 2 already tracks subagent children: the footer shows "N subagents" and `down`
 * opens a live inspector of each child's transcript, and when you *are* inside a child,
 * `up` walks back to its parent. What it deliberately does not do is let you move *into* a
 * child, so a subagent's session ID has to be looked up by hand and opened in another
 * window. This plugin fills exactly that gap and nothing else.
 *
 *   /children      pick a subagent and start typing to it in this window
 *                  (picker also has a "Steer..." action to send one message without switching)
 *   prompt footer  a badge naming the parent while you are typing into a child
 *
 * Non-intrusive by construction:
 *   - it never navigates on its own, only when a key is pressed
 *   - it adds no bindings to the existing subagent inspector, and defaults to ctrl+y,
 *     which the TUI does not otherwise use (built-ins keep down/up)
 *   - it is registered in cli.json, so it never loads on the server, web, or desktop
 *   - it reads session state only; the sole mutation is a prompt you explicitly send
 */

const MAX_TITLE = 40

function truncate(value: string, max = MAX_TITLE) {
  const clean = value.replace(/\s+/g, " ").trim()
  return clean.length <= max ? clean : `${clean.slice(0, max - 1)}…`
}

export default Plugin.define({
  id: "opencode-subchat",
  setup(context) {
    const { client, data, keymap, ui } = context

    /** Descendant sessions of a root, deepest last, in stable title order. */
    const descendants = (sessionID: string) =>
      data.session
        .family(sessionID)
        .filter((id) => id !== sessionID)
        .map((id) => data.session.get(id))
        .filter((session): session is NonNullable<typeof session> => session !== undefined)
        .toSorted((left, right) => (left.title ?? left.id).localeCompare(right.title ?? right.id))

    /** Levels below `root`: a direct child is 1, a grandchild 2. Bounded against a cycle. */
    const depthOf = (sessionID: string, root: string) => {
      let depth = 0
      let cursor = sessionID
      while (cursor !== root && depth < 32) {
        const parent = data.session.get(cursor)?.parentID
        if (!parent) return depth
        cursor = parent
        depth++
      }
      return depth
    }

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

    keymap.layer(() => ({
      mode: "global",
      priority: 10,
      commands: [
        {
          id: "subchat.children",
          title: "Go to subagent",
          description: "Talk to a subagent from this session",
          group: "Session",
          palette: true,
          slash: { name: "children", aliases: ["subagents"] },
          // Free in the TUI; ctrl+g and ctrl+alt+g belong to session.first / session.last.
          bind: "ctrl+y",
          suggested: () => {
            const route = ui.router.current()
            return route.type === "session" && descendants(route.sessionID).length > 0
          },
          enabled: () => {
            const route = ui.router.current()
            return route.type === "session" && descendants(route.sessionID).length > 0
          },
          run: async () => {
            const route = ui.router.current()
            if (route.type !== "session") {
              ui.toast.show({ message: "Open a session first", variant: "warning" })
              return
            }
            const root = route.sessionID
            const children = descendants(root)
            if (children.length === 0) {
              ui.toast.show({ message: "No subagents in this session", variant: "info" })
              return
            }

            const options = children.map((child) => ({
              title: truncate(child.title ?? child.id),
              value: child.id,
              description: [
                data.session.status(child.id) === "running" ? "running" : "idle",
                depthOf(child.id, root) > 1 ? `depth ${depthOf(child.id, root)}` : undefined,
              ]
                .filter(Boolean)
                .join(" · "),
              category: depthOf(child.id, root) > 1 ? "nested" : "direct",
            }))

            const chosen = await ui.dialog.select({
              title: children.length === 1 ? "Subagent" : `Subagents (${children.length})`,
              options,
              current: route.sessionID,
              actions: [
                {
                  bind: "ctrl+o",
                  title: "Steer...",
                  side: "right",
                  onTrigger: async (sessionID) => {
                    const text = await ui.dialog.prompt({
                      title: `Steer ${truncate(data.session.get(sessionID)?.title ?? sessionID, 28)}`,
                      placeholder: "Message to send to the running subagent",
                    })
                    if (text?.trim()) await steer(sessionID, text.trim())
                  },
                },
              ],
            })
            if (!chosen) return

            // The composer follows the route, so navigating is the whole switch.
            ui.router.navigate({ type: "session", sessionID: chosen })
          },
        },
      ],
    }))

    // Names the parent only while the composer targets a child, so the badge is absent in
    // the common case instead of adding permanent chrome to the footer.
    context.ui.slot({
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
  },
})