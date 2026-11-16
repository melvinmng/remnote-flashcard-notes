# Flashcard Notes

A RemNote plugin that adds a bullet-list notes field below the current flashcard in the queue.

Long cards (lists, definitions, multi-step explanations) are hard to check in your head. Write down
everything you remember before revealing the answer, then compare your notes with the back of the
card and rate yourself as usual.

- No grading, no AI credits: the field is a plain scratchpad.
- Notes are temporary and never written to your knowledge base.
- The plugin requests no permissions.

## Usage

Start a flashcard queue. The notes field appears below the question. Click into it and start typing.

### Keyboard shortcuts

| Key | Action |
|---|---|
| `Enter` | Start a new bullet (splits the bullet at the cursor) |
| `Option` + `Enter` (`Alt` + `Enter` on Windows/Linux) | Line break inside the current bullet |
| `Backspace` at the start of a bullet | Merge it into the previous bullet |
| `↑` / `↓` on the first / last line | Move to the previous / next bullet |
| `Esc` | Leave the field so the queue shortcuts (`Space`, `1`–`4`) work again |

Wrapped lines and line breaks stay indented behind the bullet dot.

The clear button (×) in the top-right corner of the field empties all bullets. The field is also
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
  the widget when the answer is revealed). Session storage is cleared when the next card loads and
  when RemNote restarts.

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
installed from `https://www.remnote.com/plugins/flashcard-notes`. Remove the flag to list it publicly.

## Project structure

```text
public/
  manifest.json          Plugin metadata (id, version, permissions, unlisted flag)
  logo.svg               Plugin icon
src/
  widgets/
    index.tsx            Plugin entry: registers settings and the queue widget
    flashcard_notes.tsx  Notes field (bullet editor, keyboard handling, session restore)
  index.css              Widget styles (light/dark theme)
  style.css              Tailwind base styles from the RemNote template
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
