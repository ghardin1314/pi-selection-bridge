# Pi Selection Bridge VS Code Extension

This is the editor-side extension for the Pi Selection Bridge.

It writes the latest non-empty selection to:

`~/.pi/bridge/<workspace-hash>/selection.json`

The Pi package consumes that file on the next prompt.

## Local dev

```bash
npm install
npm run watch
```

To test in Cursor:

```bash
npm run push:cursor
```

Then reload Cursor:
- `Developer: Reload Window`
