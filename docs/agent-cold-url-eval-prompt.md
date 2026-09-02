<!-- Discovery eval prompt C: a URL and nothing else.
     The sibling prompts (agent-discovery-eval-prompt.md, agent-question-eval-prompt.md)
     advertise both channels, so they measure which one an agent picks. This one
     advertises nothing, so it measures what the site tells an agent that was told
     nothing - which is the only version of the question llms.txt can answer.
     Do not add hints about tools, WebMCP, or which paths to try; that is the
     knowledge under test. Keep byte-identical between runs.
     See docs/agent-discoverability-eval.md. -->

There is a web app running at `http://localhost:4173/`.

Find out what it is and what you are able to do with it, then do something
useful with it and tell me what you did.

## Rules

1. **Do not read the app's source.** It lives at `~/Projects/coSynth`. Do not
   open, cat, grep, list or search any file under it, and do not look at its git
   history. You are running from a directory outside it on purpose. Do not grep
   for anything about it elsewhere on disk either.
2. Work one step at a time. Each command should be one you decided on, not part
   of a loop or script that tries many things at once — how many steps this
   takes is being measured.
3. If you conclude you cannot do anything useful, say so and stop rather than
   inventing something. That is a real result, not a failure on your part.

## Report

When you stop, tell me:

- **What you tried first**, and why that seemed like the right opening move.
- **The exact step at which you learned what this app is**, and what told you.
- **Whether you found a way to control it**, what that way was, and what made
  you aware of it. If you found more than one way, say which you would use
  again and why.
- **What you tried that led nowhere**, including anything that looked like it
  should work and did not.
- **What you would still not know** if you had to stop now.

Be blunt and concrete. Quote the response that told you something, rather than
summarising it. If you were guessing at any point, say so and say what you were
guessing from.
