<!-- Discovery eval prompt A: an explicit task, both channels available.
     See docs/agent-discoverability-eval.md for the method and results.
     Keep byte-identical between runs. -->

You are working with a web app that is already open and running at
`http://localhost:4173/`. Your job is to make it produce a **bright, plucky
sound and play a short chord**, and then tell me what you did.

You reach the app through a local HTTP bridge on `http://localhost:4791`. Two
sets of capabilities are available to you. Both are real; use whichever you
judge best, in any order.

**Page access** — what a browser gives you:

```bash
curl -s http://localhost:4791/page/text                                    # visible text of the rendered page
curl -s http://localhost:4791/page/html                                    # the HTML as served
curl -s http://localhost:4791/page/a11y                                    # the accessibility tree
curl -s -X POST http://localhost:4791/page/click -d '{"text":"OSC 1"}'     # click by text, or {"selector":"#id"}
curl -s -X POST http://localhost:4791/page/eval  -d '{"expression":"document.title"}'   # inspect via JS
```

**WebMCP tools** — the page registers tools on `document.modelContext`, the way
a WebMCP-enabled site exposes actions to an agent:

```bash
curl -s http://localhost:4791/webmcp/tools                                                  # the registered tool descriptors
curl -s -X POST http://localhost:4791/webmcp/call -d '{"tool":"NAME","input":{}}'           # invoke one
```

## Rules

1. **Do not read the app's source.** It lives at `~/Projects/coSynth`. Do not
   open, cat, grep, list or search any file under it, and do not look at its git
   history. You are running from a directory outside it on purpose. Everything
   you need is reachable through the bridge above.
2. Work one step at a time. Do not write a loop or a script that fires many
   calls at once — the number of round trips is being measured, so each call
   should be one you actually decided on.
3. If you get stuck, say so and make your best next attempt through the bridge.
   Do not go looking at the code to recover.
4. Do not call `POST /reset` — it erases the measurement.

## Report

When you are done, say in a few sentences:

- **What you did first, and why.** Which of the two channels you reached for
  before the other, and what made you choose it.
- **How you found out what the app could do.** Name the specific response that
  told you.
- **Whether anything misled you** — something that looked available and was
  not, or a name that did not match what it returned.
- **What you would have wanted to know up front** that you had to work out.

Be blunt. If one channel was obviously better, say which and why. If you nearly
missed something, say what nearly hid it.
