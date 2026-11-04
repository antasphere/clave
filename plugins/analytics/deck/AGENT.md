# An Analytics deck written by Clave

This folder is one page of Clave's bundled Analytics plugin, written as a Slideless deck: a session's, a group's or the workspace's account of what the agents cost, read from the Claude Code transcripts on this Mac at list prices.

- `index.html` is the page, self-contained: the stylesheet, the script and the data are inside it. Open it in a browser, or let the Slideless viewer serve it (`slideless dev` on the parent folder, which Clave runs for you).
- `data.json` is the same data the page draws: the figures, the activity blocks, the models, the rows (sessions and subagents with their type and description), the cards. Never a prompt, never a transcript line.
- Clave rewrites this folder whenever the page's data changes, from the moment the page was opened for as long as Clave runs. Anything you add here may be overwritten.

The folder is yours. If you ever want it on Slideless, `slideless push <this folder>` does it on your own login; Clave never pushes anything.
