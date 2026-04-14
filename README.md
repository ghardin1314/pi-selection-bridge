# Pi Selection Bridge

A single Pi package that includes:
- the Pi extension
- the Cursor/VS Code extension source
- a bundled `.vsix` for editor install

## End-user install

Install the Pi package:

```bash
pi install git:github.com/ghardin1314/pi-selection-bridge
```

For local testing from this checkout:

```bash
pi install /Users/garrett/Documents/github/experiments/vscode-highlight
```

Then inside Pi:

```text
/selection-bridge install cursor
```

Or for VS Code:

```text
/selection-bridge install vscode
```

Then:
- reload the editor window
- select code in the editor
- send your next Pi prompt

## Pi commands

- `/selection-bridge status`
- `/selection-bridge doctor`
- `/selection-bridge install cursor`
- `/selection-bridge install vscode`

## Local dev

Install editor-extension deps once:

```bash
cd vscode-extension
npm install
```

From the repo root:

```bash
npm run watch:vscode
```

When ready to test in Cursor:

```bash
npm run push:cursor
```

That will:
- build the editor extension
- package `assets/pi-selection-bridge.vsix`
- install it into Cursor

Then:
- reload Cursor
- run `/reload` in Pi

## Repo layout

- `extensions/` — Pi extension package contents
- `assets/pi-selection-bridge.vsix` — bundled editor extension
- `vscode-extension/` — editor extension source
