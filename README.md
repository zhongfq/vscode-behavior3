# Behavior Tree Editor

A visual behavior tree editor for VSCode, designed for game AI development.

## Features

- **Visual canvas** — drag-and-drop behavior tree editing powered by AntV G6
- **Inspector sidebar** — click any node or tree to edit its properties in a dedicated panel
- **`.b3tree` file format** — dedicated extension to avoid conflict with plain JSON; also supports opening `.json` files via right-click → "Open With"
- **Node definitions** — load custom node types from a `.b3-setting` config file
- **Build command** — compile behavior trees with a single click (requires `.b3-setting`)
- **Expression validation** — optional syntax checking for expression-type arguments
- **Dark / light theme** — follows VSCode's current color theme

## Getting Started

### 1. Open a behavior tree file

Open any `.b3tree` file — the editor will open automatically in the custom canvas view.

To open a `.json` behavior tree:
- Right-click the file in Explorer → **Open With** → **Behavior Tree Editor**

### 2. Create a new tree

Right-click a folder in the Explorer → **Behavior Tree: New .b3tree File**

### 3. Configure node definitions

Create a `.b3-setting` JSON file in your workspace that defines your custom node types:

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

The extension will automatically discover `.b3-setting` files in your workspace root. You can also specify a path explicitly via settings.

### 4. Build

Click the **▶ Build** button in the editor title bar (requires a `.b3-setting` file with a build configuration).

## Extension Settings

| Setting | Type | Default | Description |
|---|---|---|---|
| `behavior3.settingFile` | string | `""` | Path to node config file (relative to workspace root). Leave empty for auto-discovery. |
| `behavior3.checkExpr` | boolean | `true` | Enable expression syntax validation for expression-type node arguments. |

## Inspector Sidebar

Click the **Behavior Tree** icon in the Activity Bar to open the Inspector panel.

- **Select a node** on the canvas → edit its `args`, `input`/`output` variables, `desc`, `debug`, `disabled`
- **Click empty canvas** → edit tree-level properties (`name`, `desc`, `vars`, `import`, `group`)

## Keyboard Shortcuts

| Key | Action |
|---|---|
| `Ctrl/Cmd+Z` | Undo |
| `Ctrl/Cmd+Shift+Z` | Redo |
| `Delete` / `Backspace` | Delete selected node |
| `Ctrl/Cmd+C` | Copy node |
| `Ctrl/Cmd+V` | Paste node |
| `Ctrl/Cmd+A` | Select all |
| `Ctrl/Cmd+F` | Fit canvas to screen |

## Requirements

- VSCode 1.85.0 or higher

## License

MIT
