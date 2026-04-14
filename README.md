# Pi Selection Bridge

Use your current Cursor or VS Code selection as one-shot context for the next Pi prompt, even when Pi is running in a separate terminal.

No marketplace publishing required: this repo ships as a Pi package and includes a bundled editor `.vsix`.

> Warning: this was fully vibe coded. Use at your own discretion.

## Install

### 1. Install the Pi package

```bash
pi install git:github.com/ghardin1314/pi-selection-bridge
```

Or from a local checkout:

```bash
pi install /path/to/pi-selection-bridge
```

### 2. Install the bundled editor extension

Inside Pi:

```text
/selection-bridge install cursor
```

Or for VS Code:

```text
/selection-bridge install vscode
```

### 3. Reload the editor window

Then:
- select code in the editor
- return to Pi
- send your next prompt

## Commands

- `/selection-bridge status`
- `/selection-bridge doctor`
- `/selection-bridge install cursor`
- `/selection-bridge install vscode`

## Uninstall

Remove the editor extension from Cursor:

```bash
cursor --uninstall-extension ghardin1314.pi-selection-bridge-vscode
```

If you installed an older dev build first, you may need:

```bash
cursor --uninstall-extension garrett.pi-selection-bridge-vscode
```

Remove the Pi package:

```bash
pi remove git:github.com/ghardin1314/pi-selection-bridge
```

## How it works

- the editor extension writes the latest non-empty selection to `~/.pi/bridge/<workspace-hash>/selection.json`
- the Pi extension polls for that file
- Pi shows a footer indicator when a selection is available
- on the next prompt, Pi injects the selection once and deletes the file

## Development

Install editor-extension dependencies once:

```bash
cd vscode-extension
npm install
```

From the repo root:

```bash
npm run watch:vscode
```

To rebuild and install into Cursor:

```bash
npm run push:cursor
```

Then:
- reload Cursor
- run `/reload` in Pi

## Repo layout

- `extensions/` — Pi extension
- `assets/pi-selection-bridge.vsix` — bundled editor extension
- `vscode-extension/` — editor extension source

## License

MIT
