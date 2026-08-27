# Private AI Assistant

A local AI coding assistant for VS Code, designed with a **security-first, fail-closed architecture**.

The assistant runs primarily with a local LLM through [Ollama](https://ollama.com), keeping model inference on the user's machine. System-affecting operations are protected by centralized authorization, workspace boundaries, input validation, and explicit user approval.

---

## Features

### 🔒 Local-First & Privacy-Focused

- Local LLM inference through Ollama
- No cloud LLM is required for normal operation
- No telemetry by design
- Project data remains local unless a network-enabled feature is explicitly used
- Security controls are enforced before tool execution

### 💬 VS Code Chat

- Sidebar chat panel
- Streaming responses
- Code block rendering with copy buttons
- Response timing information
- Conversation/session memory
- Session compression for long conversations

### 🛠️ File Operations

- **Read files**
- **Create and write files**
- **Edit and patch files**
- **Delete files**
- **Search files**
- **List directories**
- Workspace boundary enforcement
- Input validation
- User approval for protected operations
- Visual diff preview for file modifications

### ⚙️ Controlled Command Execution

- Command execution through a dedicated tool
- Allowlist-based command restrictions
- Security validation before execution
- Explicit approval for protected operations
- Execution timeouts and resource controls

### 🔧 Git Integration

- Git operations through a dedicated tool
- Security checks before execution
- Workspace-aware operations

### 🌐 Controlled Web Access

- Network access is isolated behind a dedicated tool
- Web operations are subject to the same tool execution security boundary

### 🧠 Context & Memory

- Active file awareness
- Cursor/selection context
- Git branch awareness
- `@filename` references
- Conversation memory
- Cross-session memory
- `/remember` command

### ⌨️ Keybindings

| Shortcut | Action |
|----------|--------|
| `Ctrl+Alt+I` | Open chat |
| `Ctrl+Alt+L` | Clear conversation |
| `Ctrl+Alt+A` | Ask about selection |
| `Ctrl+Alt+E` | Explain selected code |

### 🖱️ Context Menus

**Editor**
- Ask
- Explain
- Fix
- Generate Tests
- Generate Docs

**Explorer**
- Ask about this file

**Editor Title**
- Open chat

---

## 🔐 Security Architecture

Security is the primary architectural requirement of the project.

The LLM is treated as an **untrusted component**.

It does not receive direct access to the filesystem, terminal, Git, or other system resources.

All tool operations pass through a centralized execution boundary:

```text
User Request
     ↓
    Agent
     ↓
    LLM
     ↓
 Tool Request
     ↓
 Tool Registry
     ↓
ToolExecutionGateway
     ↓
 Security / Permission Checks
     ↓
 User Approval
     ↓
 Tool Execution
     ↓
   Result
     ↓
    Agent
     ↓
Final Response