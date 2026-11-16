# Flashcard Notes

Adds a plain notes field below the current flashcard in the RemNote queue.

Use it to write down everything you remember for long cards (lists, definitions,
multi-step explanations) before revealing the answer, then compare your notes
with the back of the card and rate yourself.

## Behavior

- The field appears below every flashcard while practicing in the queue.
- Notes are temporary: they are cleared when the next card loads and are never
  written to your knowledge base.
- No grading, no AI credits, no permissions: the plugin requests no scopes.
- `Esc` leaves the field so the usual queue shortcuts (Space, 1-4) work again.

## Settings

| Setting | Default | Effect |
|---|---|---|
| Minimum height of the notes field (lines) | 4 | Initial height; the field grows with its content. |
| Hide the notes field when it is empty and the answer is revealed | off | Removes the empty field after revealing. |

## Development

```bash
npm install
npm run dev     # serves the plugin on http://localhost:8080
npm run build   # validates the manifest and creates PluginZip.zip
```

In RemNote: Settings → Plugins → Build → "Develop from localhost" → `http://localhost:8080`.
