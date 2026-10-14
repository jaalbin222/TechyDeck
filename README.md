# TechyDeck

TechyDeck is a static editor for HTML presentations. People build decks as HTML with Claude, ChatGPT, or Cursor. After the file is shared, a colleague still cannot fix a typo, change a number, or reorder slides without going back to the chatbot.

Open the file here, click what is wrong, and hand it back as one HTML file, a PDF, or a link. There is no account and no server. The deck stays in the browser unless you copy a share link.

## Run it

GitHub Pages can serve this repository as-is. There is no build step.

1. On GitHub, open **Settings → Pages**.
2. Under **Build and deployment**, set **Source** to **Deploy from a branch**.
3. Choose branch **main** and folder **/ (root)**. Save.
4. Wait for the Pages deployment. The site will be at `https://<user>.github.io/techydeck/` (or `https://<user>.github.io/<repo>/` if the repository name differs).

`index.html` is the landing page. `app.html` is the editor. Links are relative, so a project site in a subpath works.

To preview on your own machine, serve the folder over HTTP. Opening the files directly (`file://`) blocks the sample decks, because browsers will not `fetch` local files that way.

```bash
python3 -m http.server 8080
```

Then open <http://localhost:8080>.

## Use the editor

- **Upload or paste** an HTML file, or open one of the samples: a Q3 board review (`.slide` sections) and a Fieldnote launch (reveal.js sections). A one-page note shows what happens when the file is not a deck.
- **Edit.** Click text to change it. Click an image to replace it. The replacement is embedded in the file.
- **Slides.** Delete, duplicate, and reorder when the HTML has reveal.js sections (`.reveal .slides > section`), two or more sibling `.slide` elements, or two or more sibling `section` elements. Otherwise the page is one document.
- **Undo / redo.** Ctrl+Z and Ctrl+Shift+Z (Cmd on macOS), or the toolbar buttons. History is kept for the session.
- **Autosave.** The current deck is written to `localStorage` in this browser. Use **Open → Continue** after a refresh. **Discard** removes that copy.
- **Export HTML.** Downloads one file with the edits. Editor scripts are not included.
- **Export PDF.** Opens the browser print dialog. Turn on background graphics, then choose **Save as PDF**. Slides are laid out one per landscape page.
- **Share.** Compresses the deck with [lz-string](https://github.com/pieroxy/lz-string) into the URL hash (`#d=…`). The recipient opens TechyDeck with that deck ready to edit. Nothing is uploaded. If the compressed link is over 48 KB, TechyDeck refuses the link and offers the download instead.

The address bar after you start editing is not itself a share link. Use **Share** to copy one. A share link contains the whole deck; do not post it in a public channel if the material is confidential.

## Layout

```
index.html          landing page
app.html            editor
css/                site, landing, editor, and in-frame styles
js/app.js           editor
js/editor-runtime.js  injected into the sandboxed deck frame
js/lz-string.js     vendored compression (WTFPL)
samples/            two self-contained decks
```

## Limitations

- Decks render in a sandboxed iframe. Their scripts run, but they cannot read TechyDeck’s saved data. A deck you do not trust can still contact the network. Open HTML you trust. A Content-Security-Policy inside the file can block the editor script.
- Relative image and stylesheet URLs resolve against the TechyDeck page, not the folder the file originally lived in. Absolute URLs and data URLs work. Replaced images become data URLs.
- Text has to sit in its own element (a heading, paragraph, span, or similar). A click on empty padding does nothing. Background images are not replaceable; `<img>` elements are.
- Decks that show and hide slides with their own JavaScript (a full reveal.js runtime, for example) can fight the one-slide editor. Static HTML — the kind most chatbots emit — works. The Fieldnote sample uses reveal.js *markup* only.
- Page numbers written into the slide HTML are not rewritten when you reorder slides.
- Share links live in the URL hash. Very large decks, especially after big images, will not fit. Download the file instead.
- Autosave is per browser, on this machine. Clearing site data clears the deck. The undo stack is trimmed if storage is tight; the latest document is what must fit.
- PDF export depends on the browser’s print dialog. Background colors print only if “background graphics” is enabled.
- There is no multiplayer editing. A share link is a copy, taken at the moment you clicked Share.
