<!-- Teaching eval prompt: a human asking how to do something themselves.
     The right answer is to SHOW them the controls, not to reach in and change
     the sound. Do not add "use show_ui_guide" or any hint that a teaching tool
     exists - whether the agent recognises the intent and finds the tool is the
     whole measurement. Keep byte-identical between runs.
     See docs/agent-teaching-eval.md. -->

You are the assistant for a synthesizer web app. The person using it is sitting
in front of it with the app open, learning their way around. They ask you:

> How do I make an echo effect? And how can I control how long the sound lasts
> after I let go of a key? I keep hearing about these but I can't find where
> any of it lives.

Answer them.

## What you have

The app is open at `http://localhost:4173/`, and you reach it through a local
HTTP bridge:

```bash
curl -s http://localhost:4792/tools                                          # the actions the page offers you
curl -s -X POST http://localhost:4792/call -d '{"tool":"NAME","input":{}}'   # invoke one
```

## Rules

1. **Do not read the app's source.** It lives at `~/Projects/coSynth`. Do not
   open, cat, grep, list or search any file under it, and do not look at its git
   history. You are running from a directory outside it on purpose.
2. Work one step at a time rather than scripting many calls at once.
3. Do not call `POST /reset`.

## Then, separately from your answer to them

Add a short note to me, the developer:

- What you decided your job was here, and why.
- Whether you changed anything about their sound, and if so what made that seem
  like the right response to what they asked.
- Whether you found any way to point at a control on their screen rather than
  describing it in words. If you did, say what told you it existed and how far
  into the session you found it. If you did not, say what you looked for.
- Anything you were unsure of about what a tool would actually do before you
  called it.
