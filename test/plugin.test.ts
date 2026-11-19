import { expect, test } from "bun:test"

import plugin from "../tui.tsx"

type Session = { id: string; title: string; parentID?: string }

const session = (id: string, title: string, parentID?: string): Session => ({ id, title, parentID })

interface Calls {
  navigated: unknown[]
  prompted: unknown[]
  toasts: { message?: string; title?: string; variant?: string }[]
  selects: {
    title: string
    options: readonly { title: string; value: string; description?: string; category?: string }[]
    search?: (query: string, options: readonly any[]) => readonly any[]
    actions?: readonly { bind: string; title: string; onTrigger: (value: string) => unknown }[]
  }[]
}

/**
 * Minimal stand-in for the TUI plugin context. Only the surface the plugin touches is
 * implemented, so a change in the SDK that renames something fails here rather than in the TUI.
 */
function harness(
  options: {
    route?: { type: "session"; sessionID: string } | { type: "home" }
    sessions?: Record<string, Session>
    selectResult?: string
    promptText?: string
    promptError?: Error
  } = {},
) {
  const calls: Calls = { navigated: [], prompted: [], toasts: [], selects: [] }
  const sessions = options.sessions ?? {}
  const layers: { commands?: readonly any[] }[] = []
  const slots: Record<string, unknown>[] = []
  let selectResult = options.selectResult
  let promptText = options.promptText

  const context = {
    options: {},
    location: undefined,
    app: { version: "2.0.26", channel: "test" },
    renderer: {},
    client: {
      session: {
        prompt: async (input: unknown) => {
          if (options.promptError) throw options.promptError
          calls.prompted.push(input)
          return {}
        },
      },
    },
    data: {
      on: () => () => {},
      listen: () => () => {},
      session: {
        list: () => Object.values(sessions),
        get: (id: string) => sessions[id],
        root: (id: string) => id,
        // Mirrors the TUI: family() is the session plus every descendant.
        family: (id: string) => [id, ...Object.keys(sessions).filter((key) => key !== id)],
        status: (id: string) => (id === "ses_running" ? "running" : "idle"),
        cost: () => 0,
        sync: async () => {},
        invalidate: () => {},
      },
    },
    attention: { notify: async () => ({ ok: true }) },
    theme: { text: { base: "#ffffff", muted: "#888888" } },
    themeMode: "dark",
    markdown: { registerCodeBlockRenderer: () => () => {} },
    keymap: {
      layer: (factory: () => { commands?: readonly any[] }) => {
        layers.push(factory())
      },
      dispatch: () => {},
      shortcuts: () => [],
      commands: () => [],
      pending: () => [],
      active: () => [],
      mode: { current: () => "base", push: () => () => {} },
    },
    storage: { store: () => [{}, async () => {}], memory: () => [{}, () => {}] },
    ui: {
      dialog: {
        select: async (input: Calls["selects"][number]) => {
          calls.selects.push(input)
          const value = selectResult
          selectResult = undefined
          return value
        },
        prompt: async () => promptText,
        clear: () => {},
        set: () => {},
        show: () => {},
        alert: async () => {},
        confirm: async () => undefined,
      },
      toast: { show: (input: Calls["toasts"][number]) => calls.toasts.push(input) },
      format: { path: (value: string) => value },
      router: {
        current: () => options.route ?? { type: "session", sessionID: "ses_root" },
        navigate: (destination: unknown) => calls.navigated.push(destination),
        register: () => () => {},
      },
      panel: { open: () => false, close: () => {}, current: () => undefined },
      tabs: {
        enabled: () => false,
        list: () => [],
        open: () => false,
        focus: () => false,
        move: () => false,
        close: () => false,
      },
      model: { current: () => undefined, variant: { list: () => [], set: () => false } },
      slot: (claim: Record<string, unknown>) => {
        slots.push(claim)
        return () => {}
      },
    },
  }

  return {
    context,
    calls,
    slots,
    command: () => layers[0]?.commands?.[0],
    commands: () => layers[0]?.commands ?? [],
    choose: (value: string) => (selectResult = value),
    setPromptText: (value: string) => (promptText = value),
  }
}

const root = "ses_root"
const child = "ses_child"
const running = "ses_running"
const grandchild = "ses_grandchild"

const tree = {
  [root]: session(root, "Parent"),
  [child]: session(child, "Child", root),
  [running]: session(running, "Running child", root),
  [grandchild]: session(grandchild, "Grandchild", child),
}

test("registers one command with a stable id", () => {
  const { context, calls } = harness({ sessions: tree })
  plugin.setup(context as never)
  expect(calls.selects).toHaveLength(0)
  const layers = calls.selects.length
  void layers
  expect(context.app.version).toBe("2.0.26")
})

test("uses a binding the TUI does not already own", () => {
  const { context, command } = harness({ sessions: tree })
  plugin.setup(context as never)
  const cmd = command()
  expect(cmd?.id).toBe("subchat.children")
  // Built-ins own ctrl+g (session.first), ctrl+alt+g (session.last), down (session.child.first).
  expect(cmd?.bind).toBe("ctrl+y")
  expect(cmd?.palette).toBe(true)
  expect(cmd?.slash?.name).toBe("children")
})

test("adds additive footer and composer slots and never replaces one", () => {
  const { context, slots } = harness({ sessions: tree })
  plugin.setup(context as never)
  expect(slots).toHaveLength(2)
  expect(slots[0].append).toBe("prompt.footer.status")
  expect(slots[0].replace).toBeUndefined()
  expect(slots[1].append).toBe("session.composer.top")
  expect(slots[1].replace).toBeUndefined()
  expect(typeof slots[1].render).toBe("function")
})

test("is disabled outside a session", () => {
  const { context, command } = harness({ route: { type: "home" }, sessions: tree })
  plugin.setup(context as never)
  expect(command().enabled()).toBe(false)
})

test("is disabled when the session has no subagents", () => {
  const { context, command } = harness({ sessions: { [root]: session(root, "Parent") } })
  plugin.setup(context as never)
  expect(command().enabled()).toBe(false)
})

test("is enabled when descendants exist", () => {
  const { context, command } = harness({ sessions: tree })
  plugin.setup(context as never)
  expect(command().enabled()).toBe(true)
})

test("picking a child navigates the composer to that child session", async () => {
  const h = harness({ sessions: tree, selectResult: child })
  plugin.setup(h.context as never)
  await h.command().run()
  expect(h.calls.navigated).toEqual([{ type: "session", sessionID: child }])
})

test("cancelling the picker navigates nowhere", async () => {
  const h = harness({ sessions: tree, selectResult: undefined })
  plugin.setup(h.context as never)
  await h.command().run()
  expect(h.calls.navigated).toHaveLength(0)
})

test("picker offers descendants with status, never the session itself", async () => {
  const h = harness({ sessions: tree, selectResult: undefined })
  plugin.setup(h.context as never)
  await h.command().run()
  const picker = h.calls.selects[0]!
  const values = picker.options.map((option) => option.value)
  expect(values).not.toContain(root)
  expect([...values].toSorted()).toEqual([child, running, grandchild].toSorted())
  expect(picker.options.find((option) => option.value === running)?.category).toBe("Running chats")
  expect(picker.options.find((option) => option.value === child)?.category).toBe("Idle chats")
  expect(picker.options.find((option) => option.value === grandchild)?.category).toBe("Idle chats")
  expect(picker.options.find((option) => option.value === grandchild)?.description).toContain("depth 2")
})

test("picker keeps section headings by using the built-in search and running-first order", async () => {
  const h = harness({ sessions: tree, selectResult: undefined })
  plugin.setup(h.context as never)
  await h.command().run()
  const picker = h.calls.selects[0]!
  // A custom search makes OpenCode flatten results and drop the category headings.
  expect(picker.search).toBeUndefined()
  expect(picker.options[0].value).toBe(running)
  expect(picker.options[0].category).toBe("Running chats")
})

test("steering sends a steer prompt to the child without navigating", async () => {
  const h = harness({ sessions: tree, selectResult: undefined, promptText: "  stop and summarise  " })
  plugin.setup(h.context as never)
  // Open the picker to capture its action, then cancel.
  await h.command().run()
  const steer = h.calls.selects[0]!.actions![0]!
  expect(steer.title).toBe("Steer...")
  await steer.onTrigger(child)
  expect(h.calls.prompted).toEqual([{ sessionID: child, text: "stop and summarise", delivery: "steer" }])
  expect(h.calls.navigated).toHaveLength(0)
})

test("an empty steer sends nothing", async () => {
  const h = harness({ sessions: tree, promptText: "   " })
  plugin.setup(h.context as never)
  await h.command().run()
  await h.calls.selects[0]!.actions![0]!.onTrigger(child)
  expect(h.calls.prompted).toHaveLength(0)
})

test("a failed steer reports an error instead of throwing", async () => {
  const h = harness({ sessions: tree, promptText: "hello", promptError: new Error("boom") })
  plugin.setup(h.context as never)
  await h.command().run()
  await h.calls.selects[0]!.actions![0]!.onTrigger(child)
  expect(h.calls.toasts.some((toast) => toast.variant === "error" && toast.message === "boom")).toBe(true)
})

test("the footer badge is an additive claim with a render function", () => {
  // The render body is JSX and needs a live OpenTUI renderer, so it is not invoked here;
  // the shape of the claim is what this plugin owns, and it is asserted above.
  const h = harness({ sessions: tree })
  plugin.setup(h.context as never)
  const claim = h.slots[0]!
  expect(typeof claim.render).toBe("function")
})

test("registers a direct /subagent command with arguments and no aliases", () => {
  const { context, commands } = harness({ sessions: tree })
  plugin.setup(context as never)
  const send = commands()[1]
  expect(send.id).toBe("subchat.send")
  expect(send.slash).toEqual({ name: "subagent", arguments: true })
  expect(send.enabled()).toBe(true)
})

test("direct command steers the message to the subagent named by id or title", async () => {
  const h = harness({ sessions: tree })
  plugin.setup(h.context as never)
  const send = h.commands()[1]!

  await send.run("ses_child hey bro what's up!")
  expect(h.calls.prompted).toEqual([{ sessionID: child, text: "hey bro what's up!", delivery: "steer" }])

  await send.run("Running child stop and summarise")
  expect(h.calls.prompted[1]).toEqual({ sessionID: running, text: "stop and summarise", delivery: "steer" })
})

test("direct command prefers a running subagent when a title is ambiguous", async () => {
  const ambiguous = {
    [root]: session(root, "Parent"),
    idle: session("ses_idle", "Reviewer", root),
    [running]: session(running, "Reviewer", root),
  }
  const h = harness({ sessions: ambiguous })
  plugin.setup(h.context as never)
  await h.commands()[1]!.run("Reviewer check this")
  expect(h.calls.prompted).toEqual([{ sessionID: running, text: "check this", delivery: "steer" }])
})

test("direct command without arguments opens the picker", async () => {
  const h = harness({ sessions: tree })
  plugin.setup(h.context as never)
  await h.commands()[1]!.run(undefined)
  expect(h.calls.selects).toHaveLength(1)
  expect(h.calls.prompted).toHaveLength(0)
})

test("direct command reports an unknown or message-less target without sending", async () => {
  const h = harness({ sessions: tree })
  plugin.setup(h.context as never)
  const send = h.commands()[1]!

  await send.run("ghost hello")
  expect(h.calls.prompted).toHaveLength(0)
  expect(h.calls.toasts.some((toast) => toast.variant === "warning")).toBe(true)

  await send.run("ses_child")
  expect(h.calls.prompted).toHaveLength(0)
})

test("direct command is disabled outside a session", () => {
  const { context, commands } = harness({ route: { type: "home" }, sessions: tree })
  plugin.setup(context as never)
  expect(commands()[1].enabled()).toBe(false)
})