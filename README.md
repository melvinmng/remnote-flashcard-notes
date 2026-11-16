# Flashcard Notes

A RemNote plugin that adds a notes field with bullet and numbered lists below the current flashcard in the queue.

Long cards (lists, definitions, multi-step explanations) are hard to check in your head. Write down
everything you remember before revealing the answer, then compare your notes with the back of the
card and rate yourself as usual.

- No grading, no AI credits: the field is a plain scratchpad.
- Notes are temporary and never written to your knowledge base.
- The plugin requests no permissions.

## Usage

Start a flashcard queue. The notes field appears below the question. Click into it and start typing.

### Lists

The field starts as plain text. Lists start with Markdown-style prefixes at the beginning of a line:

| Type | Result |
|---|---|
| `-` followed by a space | Bullet list |
| `1.` followed by a space | Numbered list (any number works, e.g. `3. ` starts at 3) |

Wrapped lines and line breaks stay indented behind the bullet or number.

### Mobile

The plugin is enabled on mobile. Lists (`- ` / `1. `), `Enter` for the next item, the counter and
the clear button work with the touch keyboard. Keyboard shortcuts that need a hardware keyboard
(`Option` + `Enter`, `Cmd` + `A`, `Esc`, undo shortcuts) are desktop-only, and the shortcut hints
are hidden on touch devices.

Pasting multi-line text splits it into separate lines. Lines starting with `- ` or `1. ` become
list items, so lists copied from elsewhere keep their structure.

### Keyboard shortcuts

| Key | Action |
|---|---|
| `Enter` | New line; inside a list it starts the next item (splits at the cursor) |
| `Enter` on an empty list item | End the list and continue with plain text |
| `Option` + `Enter` (`Alt` + `Enter` on Windows/Linux) | Line break inside the current line or item |
| `Backspace` at the start of a list item | Remove the bullet or number, keep the text |
| `Backspace` at the start of a plain line | Merge it into the line above |
| `↑` / `↓` at the start / end of a line | Move to the previous / next line |
| `Cmd` + `A` / `Ctrl` + `A` | Select the whole field (all lines). Then `Backspace` clears it, typing replaces it, `Cmd`/`Ctrl` + `C`/`X` copies or cuts it as Markdown-style text |
| `Cmd` + `Z` / `Ctrl` + `Z` | Undo across all lines (typing bursts are undone together) |
| `Cmd` + `Shift` + `Z` / `Ctrl` + `Shift` + `Z` / `Ctrl` + `Y` | Redo |
| `Esc` | Leave the field so the queue shortcuts (`Space`, `1`–`4`) work again |

A small counter below the field shows how many list items you have written (for example
`3 bullets`), so you can compare it with RemNote's "Recall 3 bullets" hint. It counts filled
bullets and numbered items; plain lines and empty items are not counted.

The clear button (×) in the top-right corner of the field empties the field. The field is also
cleared automatically when the next card loads.

### Settings

Open RemNote **Settings → Plugins → Flashcard Notes**.

| Setting | Default | Effect |
|---|---|---|
| Minimum height of the notes field (lines) | 2 | Initial height of the field. It grows with its content. |
| Hide the notes field when it is empty and the answer is revealed | off | Removes the empty field after revealing the answer. |

## Privacy

- `requiredScopes` is empty: the plugin cannot read or modify any of your Rems.
- `requestNative` is `false`: the plugin runs in RemNote's sandboxed iframe.
- No network requests.
- Notes live only in memory and in RemNote's plugin session storage (so they survive a re-render of
  the widget when the answer is revealed). The stored copy is cleared when the next card loads.

## Local development

### Requirements

- [Node.js](https://nodejs.org/) with npm. The template pins Node 16 in `.nvmrc`; the plugin also
  builds with current Node versions (tested with Node 26).
- The RemNote desktop app or the web app.

### Install dependencies

```bash
git clone https://github.com/melvinmng/remnote-flashcard-notes.git
cd remnote-flashcard-notes
npm install
```

### Start the local development server (localhost)

```bash
npm run dev
```

The plugin is served on `http://localhost:8080`. Code changes are rebuilt and reloaded automatically.
Stop the server with `Ctrl` + `C`.

### Load the plugin in RemNote

1. Open **Settings → Plugins**.
2. Switch to the **Build** tab.
3. Click **Develop from localhost**.
4. Enter `http://localhost:8080` and confirm.
5. Start a flashcard queue to see the notes field.

The plugin is only available while `npm run dev` is running. After restarting RemNote you may have
to repeat steps 1–4.

### Other scripts

| Command | Purpose |
|---|---|
| `npm run dev` | Development server with hot reload on port 8080 |
| `npm run check-types` | TypeScript type check |
| `npm test` | Behavior tests for list parsing, copy/paste and serialization |
| `npm run build` | Validate manifest/README/logo, build to `dist/` and create `PluginZip.zip` |

### Troubleshooting

| Problem | Fix |
|---|---|
| `Port 8080 is already in use` | Stop the other process: `lsof -ti:8080 \| xargs kill`, then run `npm run dev` again. |
| Plugin does not appear in the queue | Check that `npm run dev` is running and `http://localhost:8080/manifest.json` opens in the browser. Re-add it via **Develop from localhost**. |
| Queue shortcuts do not react | The cursor is still in the notes field. Press `Esc` or click outside the field. |
| `npm run build` fails with `not a git repository` | The validator expects a git repository. Run the build inside the cloned repository. |

## Build and publish

1. Update the version in `public/manifest.json` (and `package.json`).
2. Run `npm run build`. This validates the plugin and creates `PluginZip.zip` in the project root.
3. In RemNote open **Settings → Plugins → Build** and click **Upload plugin**. Select `PluginZip.zip`.
4. A RemNote team member reviews the code before the plugin is approved. The `repoUrl` in the
   manifest must point to this public repository.

`"unlisted": true` in `public/manifest.json` keeps the plugin off the public marketplace. It can be
installed from `https://www.remnote.com/plugins/melvinmng-flashcard-notes`. Remove the flag to list it publicly.

## Project structure

```text
public/
  manifest.json          Plugin metadata (id, version, permissions, unlisted flag)
  logo.svg               Plugin icon
src/
  widgets/
    index.tsx            Plugin entry: registers settings and the queue widget
    flashcard_notes.tsx  Notes field (list editor, keyboard handling, session restore)
  notes_model.ts         Pure data model: list detection, paste and copy logic
  index.css              Widget styles (light/dark theme)
  style.css              Tailwind base styles from the RemNote template
scripts/
  test_notes_model.ts    Tests for notes_model.ts (npm test)
webpack.config.js        Build configuration (one bundle per widget)
```

The widget location is defined once in `src/widgets/index.tsx` (`NOTES_WIDGET_LOCATION`,
currently `WidgetLocation.FlashcardUnder`).

## Note for iCloud Drive

If the project lives in iCloud Drive, keep `node_modules` out of the sync:

```bash
mv node_modules node_modules.nosync
ln -s node_modules.nosync node_modules
```

iCloud skips folders ending in `.nosync`. Both names are listed in `.gitignore`. A fresh clone
outside iCloud only needs `npm install`.

## License

MIT, see [LICENSE](LICENSE). Based on the official
[RemNote plugin template](https://github.com/remnoteio/remnote-plugin-template-react).
