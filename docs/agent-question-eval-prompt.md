<!-- Discovery eval prompt B: a user's question, not an instruction.
     This measures tool ADOPTION, not tool usability - whether an agent reaches
     for the tools when nobody tells it to. Do not add "use the tools" to this
     prompt; that would answer the question it exists to ask.
     See docs/agent-discoverability-eval.md. Keep byte-identical between runs. -->

You are the assistant in a conversation with someone using a synthesizer web
app. They have it open in front of them. They say:

> The sound is way too dull and boring. I want something that cuts through a
> mix — bright, with a bit of a pluck to it. And honestly I have no idea what
> half these knobs do. Can you sort it out?

Answer them.

## What you have

The app is open at `http://localhost:4173/` and you can reach it through a
local HTTP bridge on `http://localhost:4791`:

```bash
curl -s http://localhost:4791/page/text                                    # visible text of the rendered page
curl -s http://localhost:4791/page/html                                    # the HTML as served
curl -s http://localhost:4791/page/a11y                                    # the accessibility tree
curl -s -X POST http://localhost:4791/page/click -d '{"text":"OSC 1"}'     # click by text, or {"selector":"#id"}
curl -s -X POST http://localhost:4791/page/eval  -d '{"expression":"document.title"}'
curl -s http://localhost:4791/webmcp/tools                                                # tools the page registers on document.modelContext
curl -s -X POST http://localhost:4791/webmcp/call -d '{"tool":"NAME","input":{}}'         # invoke one
```

## Rules

1. **Do not read the app's source.** It lives at `~/Projects/coSynth`. Do not
   open, cat, grep, list or search any file under it, and do not look at its git
   history. You are running from a directory outside it on purpose.
2. Work one step at a time rather than scripting many calls at once.
3. Do not call `POST /reset`.

## Then, separately from your answer to them

Add a short note to me, the developer, covering:

- Whether you changed the actual sound or only explained what to do, and why you
  chose that.
- If you did change it: at what point did you decide to, and what made it seem
  like the right move rather than answering in words.
- If you did not: what would have made it obvious that you could.
- Anything about how the app presented itself that pushed you one way or the
  other.
