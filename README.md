# TechyDeck

TechyDeck imports an HTML presentation you already have. It is not another deck generator. A colleague can correct a number, replace a picture, or leave a comment on that element, then hand the same file back. Calculators, inline scripts, and SVG charts stay in the file. They are not flattened into a screenshot.

The live site is [https://jaalbin222.github.io/TechyDeck/](https://jaalbin222.github.io/TechyDeck/). Open [the demo](https://jaalbin222.github.io/TechyDeck/demo.html) to walk a sample deck in about a minute. The [editor](https://jaalbin222.github.io/TechyDeck/app.html) is the fuller local-mode tool. GitHub Pages only serves files. It cannot store one shared copy or decide who may edit.

## Local mode and shared mode

| | Local mode (live on Pages) | Shared mode (companion server) |
| --- | --- | --- |
| Where it runs | The static site | `node server/server.js` on a machine you control, then paste its URL in the editor |
| Text, image, slide edits | Yes, in this browser | Yes, for owner and editor |
| Anchored comments | Yes, in this browser | Yes, for owner, editor, and commenter |
| Revision list and restore | Yes, in this browser | Yes, on the server. Restore adds a new head and keeps older revisions |
| One document, several people | No | Yes, when the server is running |
| Permissions | The person at the keyboard is the owner | Owner, editor, commenter, viewer, checked on the server |
| Snapshot link | A frozen copy in the URL. Not collaboration | Still a copy. Invites are the shared path |

Nothing on the public site uploads a deck. Connecting a server is explicit: open **Connect a shared server**, paste `http://127.0.0.1:8787` (or your host), and check it. **Publish shared** creates one document and returns an owner token to this browser. **Invite editor / commenter / viewer** makes a link whose token is the permission. A viewer’s save is rejected by the server. A commenter can add a comment and cannot change the HTML.

There is no hosted TechyDeck database. Do not point the app at a public writable inbox. The server binds to `127.0.0.1` unless you set `HOST`. Putting real customer decks on an open server is your decision and needs HTTPS plus a host you administer.

```bash
node server/server.js
```

`PORT` defaults to 8787. `TECHYDECK_DATA` is the folder for document files (default `server/data/`, gitignored). Tokens are stored as SHA-256 hashes. `node server/test-api.js` checks roles, conflict responses, and restore.

## What you can edit

Supported structures, detected in this order:

1. Direct child `section` elements inside `.reveal .slides` (reveal.js markup).
2. Two or more sibling elements with class `slide`.
3. Two or more sibling `section` elements.
4. Otherwise the file is one document. Text and images can still be edited. Slide buttons stay hidden.

Editable targets are leaf elements that contain only text, and `img` elements outside inline SVG. Each one gets a stable `data-td-anchor`. Comments point at that anchor, so they follow the element when you reorder slides and come back after reload or export.

Buttons, inputs, and scripts are not editable text. Clicks on them still run the deck. A text edit updates that element in the source file. It does not reserialize whatever the script has drawn on screen. The next reload runs the original script again.

## What is not supported

- React, Vue, or any runtime that hydrates from a bundle and will break if the markup changes.
- A full reveal.js runtime that positions slides itself. The Fieldnote sample is reveal.js *markup* with TechyDeck’s own CSS.
- Shadow DOM, canvas pixels, and text inside SVG. SVG stays in the file; a caption next to it can be edited.
- `document.write`, or a deck whose Content-Security-Policy blocks the editor script.
- Every widget. `designMode` is not used, so we do not try to edit arbitrary controls.
- Relative images and stylesheets. They resolve against the TechyDeck page, not the folder the file came from. Absolute URLs and data URLs work. Replaced images become data URLs.
- Page numbers written into the HTML. Reordering does not rewrite them.
- Live collaboration inside one cursor. A newer shared save shows a banner. It does not steal focus or reload under your typing.

## Security

Uploaded HTML is untrusted. It runs in a sandboxed iframe without `allow-same-origin`, so its scripts cannot read TechyDeck’s `localStorage`, session, or tokens. Messages are accepted only from that iframe, and only as small edit or comment requests for an anchor that already exists. A script in the deck cannot swap in a different document.

A script that shares the iframe can still try to send an edit for a real anchor, because it lives in the same frame as the editor bridge. It cannot see parent storage. It can contact the network. Open files you trust.

The editor does not ask you to paste a GitHub token, and the public site does not contain one.

## Samples

- Q3 board review: `.slide` sections.
- Fieldnote launch: reveal.js sections.
- Pricing calculator: inline script, still clickable after a text edit.
- SVG chart: a chart plus a caption.
- One-page note: no slide markup.

## Pages

GitHub Pages is already serving this repository from `main` at the site root: [https://jaalbin222.github.io/TechyDeck/](https://jaalbin222.github.io/TechyDeck/). Links are relative, so the project path works. There is no build step.

To preview locally:

```bash
python3 -m http.server 8080
```

Opening the files with `file://` blocks the samples.
