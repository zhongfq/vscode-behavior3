# Behavior Tree Editor

VS Code behavior tree visual editor for game AI workflows.

## Features

- Visual canvas editor (drag, connect, organize nodes)
- Built-in inspector panel for node/tree properties
- Custom node definitions via `.b3-setting`
- One-click build command in editor title bar
- Optional expression validation for node args
- Auto theme adaptation (dark/light)

## Quick Start

### Open a tree file

- Right-click a tree `.json` file in Explorer
- Select **Open With** → **Behavior Tree Editor**

### Create a new project

- Right-click a folder in Explorer
- Run **Behavior Tree: Create Project**

### Configure nodes

Create a `.b3-setting` file in workspace:

```json
{
  "nodes": [
    {
      "name": "MyAction",
      "type": "Action",
      "desc": "Does something useful",
      "args": [
        { "name": "duration", "type": "float", "desc": "Duration in seconds" }
      ]
    }
  ]
}
```

### Build

Click **Build** in the editor title bar.

### Build Script (`.b3-workspace`)

`settings.buildScript` supports ESM scripts:

- JavaScript: `.js`, `.mjs`
- TypeScript: `.ts`, `.mts` (runtime transpile, no type-check)

Example:

```json
{
  "settings": {
    "checkExpr": true,
    "buildScript": "scripts/build.ts"
  }
}
```

All build hooks receive `env`:

- `env.fs`: Node `fs`
- `env.path`: full path helper object (all methods exposed)
- `env.workdir`: resolved workspace directory
- `env.nodeDefs`: loaded node definitions map
- `env.logger`: `log/debug/info/warn/error`

Use a `Hook` class. The extension constructs it once with `env`, then calls methods:

- `constructor(env)`
- `onProcessTree(tree, path, errors)`
- `onProcessNode(node, errors)`
- `onWriteFile(path, tree)`
- `onComplete(status)`

For compatibility:

- `.ts` / `.mts`: must export a class via named `Hook` or `default`
- `.js` / `.mjs`: support class export and legacy function-style exports

For TypeScript authoring hints, see:

- `sample/scripts/build-script.d.ts`
- `sample/scripts/build.ts`

## Extension Settings

| Setting                   | Type    | Default      | Description                                                                     |
| ------------------------- | ------- | ------------ | ------------------------------------------------------------------------------- |
| `behavior3.settingFile` | string  | `""`       | Path to `.b3-setting` relative to workspace root. Empty means auto-discovery. |
| `behavior3.checkExpr`   | boolean | `true`     | Enable expression syntax validation for expression-type args.                   |
| `behavior3.language`    | string  | `"auto"`   | Editor UI language. Options: `auto` (follow VS Code), `zh`, `en`.          |
| `behavior3.nodeLayout`  | string  | `"normal"` | Node layout style. Options: `normal`, `compact`.                            |

## Inspector

Inspector is embedded on the right side of the tree editor.

- Select a node to edit node fields (`args`, `input`, `output`, `desc`, `debug`, `disabled`)
- Click empty canvas to edit tree fields (`name`, `desc`, `vars`, `import`, `group`)

## Keyboard Shortcuts

| Key                          | Action                         |
| ---------------------------- | ------------------------------ |
| `Ctrl/Cmd+Z`               | Undo                           |
| `Ctrl+Y` / `Cmd+Shift+Z` | Redo                           |
| `Ctrl/Cmd+C`               | Copy node                      |
| `Ctrl/Cmd+V`               | Paste node                     |
| `Ctrl/Cmd+Shift+V`         | Replace node                   |
| `Enter` / `Insert`       | Insert node                    |
| `Delete` / `Backspace`   | Delete selected node           |
| `Ctrl/Cmd+F`               | Search node content            |
| `Ctrl/Cmd+G`               | Jump to node by id             |
| `Ctrl/Cmd+B`               | Build                          |
| `F4`                       | Toggle Text / Behavior3 editor |

## Development

- Output logs: **View → Output** → channel **Behavior3**
- Webview logs are also available in DevTools

## Requirements

- VS Code 1.85.0+

## License

MIT
