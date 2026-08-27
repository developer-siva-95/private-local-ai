# Private AI Assistant

A local AI coding assistant for VS Code. **100% private, no cloud, no telemetry.**

Powered by [Ollama](https://ollama.ai) running on your machine. Chat with your AI, edit files, run commands — all with full security controls.

---

## Features

### 🔒 Fully Local & Private
- No cloud APIs, no telemetry, no data leaves your machine
- Powered by Ollama running locally
- All logs stored in your workspace

### 💬 Copilot-Style Chat
- Sidebar chat panel
- Streaming responses
- Code block rendering with copy buttons
- Timing display for every response
- Session compression for long conversations

### 🛠️ Full File Operations
- **Read files** — auto-approved for workspace files
- **Write / Create** — visual diff preview before applying
- **Edit / Patch** — visual diff preview before applying
- **Delete** — explicit permission popup with full path
- **Search files** across workspace
- **Run commands** (npm, node, git, tsc — allowlist enforced)

### 🎯 Context-Aware
- Knows your active file, cursor position, git branch
- `@filename` mentions to reference specific files
- Follow-up questions use conversation memory
- Cross-session memory via `/remember` command

### ⌨️ Keybindings
| Shortcut | Action |
|----------|--------|
| `Ctrl+Alt+I` | Open chat |
| `Ctrl+Alt+L` | Clear conversation |
| `Ctrl+Alt+A` | Ask about selection |
| `Ctrl+Alt+E` | Explain selected code |

### 🖱️ Right-Click Menus
- **Editor:** Ask, Explain, Fix, Generate Tests, Generate Docs
- **Explorer:** Ask about this file
- **Editor title:** Open chat icon

### 🔐 Security-First Design
- Every destructive operation requires explicit approval
- Workspace boundary enforcement
- Command allowlist (no arbitrary shell execution)
- Path traversal prevention
- Symlink attack prevention
- Full audit log of every operation

---

## Requirements

### 1. Ollama Installed and Running
Download from [ollama.ai](https://ollama.ai) and install.

Start the server:
```bash
ollama serve