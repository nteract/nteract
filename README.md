# nteract/nteract

## What's going on?

If you're here looking for the Electron-based nteract desktop app, you can view the source [in this repo](https://github.com/nteract/archived-desktop-app). **That desktop app is not actively maintained.**

We're actively developing the spritual successor to the nteract desktop app in the [nteract/desktop repo](https://github.com/nteract/desktop).

### The New Desktop App

We're actively developing the spritual successor to the nteract desktop app in the [nteract/desktop repo](https://github.com/nteract/desktop).

The new app is a native desktop app with instant startup and intelligent environment management.

<img width="1100" height="750" alt="Screenshot 2026-02-27 at 8 33 13 AM" src="https://github.com/user-attachments/assets/06be5ab5-9390-43a9-993a-ccb07ec9139d" />

## Bringing Agents in the Loop

We're in the prelimiary stages of hooking up the realtime system from nteract/desktop to any agent of your choice. Collaborate with agents in notebooks, render interactive elements, and explore data together.

### Quick Start

#### Claude Code

```bash
# Add to Claude Code
claude mcp add nteract -- uvx nteract
```

That's it. Now Claude can execute Python code, create visualizations, and work with your data.

## What is this?

nteract is an MCP (Model Context Protocol) server that connects AI assistants like Claude to Jupyter notebooks. It enables:

- **Code execution**: Run Python in a persistent kernel
- **Real-time collaboration**: Watch the AI work in the nteract desktop app
- **Shared state**: Multiple agents can work on the same notebook
- **Environment management**: Automatic Python environment setup

## Example

Ask Claude:

> "Help me visualize my log data"

Claude will:
1. Connect to a notebook session
2. Write and execute code
3. Generate visualizations
4. Show you the results

You can open the same notebook in the [nteract desktop app](https://github.com/nteract/desktop) to see changes in real-time and collaborate with the AI.

## Installation

```bash
uvx --prerelease=allow nteract
```

## Claude Code Setup

Add nteract as an MCP server:

```bash
claude mcp add nteract -- uvx --prerelease=allow nteract
```

Or manually add to your Claude configuration:

```json
{
  "mcpServers": {
    "nteract": {
      "command": "uvx",
      "args": ["--prerelease=allow", "nteract"]
    }
  }
}
```

## Available Tools

| Tool | Description |
|------|-------------|
| `connect_notebook` | Connect to a notebook (new or existing) |
| `run_code` | Execute Python code |
| `create_cell` | Add a cell to the notebook |
| `execute_cell` | Run a specific cell |
| `get_all_cells` | View all cells in the notebook |

## Architecture

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│   Claude    │────▶│   nteract   │────▶│   runtimed  │
│  (or other  │     │ MCP Server  │     │   daemon    │
│     AI)     │     │             │     │             │
└─────────────┘     └─────────────┘     └──────┬──────┘
                                               │
                    ┌─────────────┐             │
                    │   nteract   │◀────────────┘
                    │ Desktop App │  (real-time sync)
                    └─────────────┘
```

- **nteract** (this package): MCP server for AI assistants
- **runtimed**: Low-level daemon and Python bindings ([docs](https://github.com/nteract/desktop))
- **nteract desktop**: Native app for humans to collaborate with AI

## Real-time Collaboration

The magic of nteract is that AI and humans share the same notebook:

1. AI connects via MCP and runs code
2. Human opens the same notebook in nteract desktop
3. Changes sync instantly via CRDT
4. Both see the same kernel state

This enables workflows like:
- AI does initial analysis, human refines
- Human writes code, AI debugs errors
- Multiple AI agents collaborate on complex tasks

## Development

```bash
# Clone
git clone https://github.com/nteract/nteract
cd nteract

# Install dependencies
uv sync

# Run tests
uv run pytest
```

## Related Projects

- [nteract/desktop](https://github.com/nteract/desktop) - Native desktop app
- [runtimed on PyPI](https://pypi.org/project/runtimed/) - Low-level Python bindings

## License

BSD-3-Clause
