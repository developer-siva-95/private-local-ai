# Project Context: private_ai

## 1. Project Overview

**Project Name:** `private_ai`

**Platform:** Windows / PowerShell

**Architecture:** TypeScript / Node.js

**LLM Provider:** Local Ollama

**Primary Model:** `deepseek-coder-fix`

**Primary Goal:**
Build a security-first, fail-closed AI coding agent designed to safely interact with a developer's local project environment.

The system treats the LLM as an untrusted component and places all system-affecting operations behind explicit security, authorization, and human-approval boundaries.

---

## 2. Security Architecture

Security is the highest-priority architectural requirement of the project.

### Untrusted LLM

The LLM is treated as an untrusted or potentially compromised actor.

The LLM does not receive direct access to the filesystem, terminal, or other system resources.

### Centralized Tool Execution Boundary

`ToolExecutionGateway` acts as the central enforcement boundary between the agent and executable tools.

Tool requests must pass through the gateway before execution.

### Explicit Authorization

The LLM does not determine its own permissions.

Permissions are defined by the registered tool's `Tool.permission` property and evaluated by the security layer.

### Fail-Closed Behavior

Security failures result in denial.

Unknown tools, invalid paths, missing authorization, failed security checks, or missing approvals must never fall back to permissive behavior.

### Workspace Boundary

Workspace access is protected at multiple levels:

* `SecurityPolicy` performs logical path and policy validation.
* `WorkspaceManager` performs workspace resolution and real-path validation, including symlink-related boundary checks.

### Human-in-the-Loop Approval

Tool operations require explicit user approval through the approval system.

The current implementation uses `ConsoleApprovalHandler` to request explicit `yes/no` confirmation.

---

## 3. Core Components

### Workspace

`WorkspaceManager`

Responsible for maintaining and validating the workspace boundary.

### Security

`SecurityPolicy`

Defines filesystem and workspace security rules.

`PermissionGateway`

Coordinates authorization, policy checks, and approval requirements.

### Approval System

`ApprovalController`

Manages pending approval requests.

`ApprovalService`

Coordinates approval processing.

`ConsoleApprovalHandler`

Provides interactive user confirmation through the console.

### Tools

The project uses a standardized `Tool` interface.

Current registered tool:

* `read_file`

Tool execution is centralized through `ToolExecutionGateway`.

### Agent

The `Agent` orchestrates the interaction between the user request, LLM, tool registry, security layer, and tool execution system.

The current agent loop has a maximum iteration limit to prevent uncontrolled execution.

### LLM Provider

`OllamaProvider`

Provides communication with the local Ollama server.

It also handles tool-call parsing for models that may return structured tool calls embedded within the response content.

---

## 4. Model Configuration

**Primary Model:** `deepseek-coder-fix`

The model is configured for local execution through Ollama.

The associated Modelfile defines:

* Chat message formatting
* System, user, and assistant message boundaries
* Tool definitions
* Tool-call formatting
* Stop sequences for message boundaries

The model is treated as an untrusted component regardless of its local execution environment.

---

## 5. Current Project Status

### Phase 2 — Tool Infrastructure

**Status: Complete**

The current end-to-end flow has been verified:

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
Tool Execution Gateway
    ↓
Security / Permission Checks
    ↓
User Approval
    ↓
Tool Execution
    ↓
Tool Result
    ↓
Agent / LLM
    ↓
Final Response
```

### Verification

**TypeScript type checking**

```text
npm run typecheck
```

Status: Passing

**Test suite**

```text
npm test
```

Status: Passing

Current test suite:

* `SecurityPolicy.test.ts` — 8 tests
* `PermissionGateway.test.ts` — 12 tests
* `ApprovalController.test.ts` — 7 tests
* `ToolRegistry.test.ts` — 4 tests
* `ToolInputValidator.test.ts` — 5 tests
* `FileReadTool.test.ts` — 5 tests
* `ToolExecutionGateway.test.ts` — 7 tests
* `Agent.test.ts` — 7 tests
* `ConsoleApprovalHandler.test.ts` — 5 tests

**Total: 416 tests across 30 test files.**

---

## 6. Project Structure

```text
src/
├── agent/                # Agent orchestration
├── approval/             # User approval handlers
├── config/               # Project configuration
├── llm/                  # LLM provider implementations
├── permissions/          # Permission and approval logic
├── security/             # Security policies and authorization
├── tools/                # Tool implementations and execution gateway
└── workspace/            # Workspace and filesystem boundary management

tests/
├── agent/
├── approval/
├── permissions/
├── security/
└── tools/
```

---

## 7. Development Roadmap

### Phase 3 — Controlled Write Operations

Planned components:

* `FileWriteTool`
* Secure file creation and modification
* Input validation
* Workspace boundary enforcement
* Explicit user approval
* Security-focused test coverage

### Phase 4 — Controlled File Deletion

Planned component:

* `FileDeleteTool`

Deletion operations will require stronger confirmation and additional security checks.

### Phase 5 — Controlled Command Execution

Planned component:

* `RunCommandTool`

Command execution will use a strict allowlist and multiple security controls.

Arbitrary command execution must not be permitted by default.

### Phase 6 — Auditability

Planned components:

* Security audit logging
* Approval records
* Tool execution records
* Tamper-evident logging
* Failure and denial tracking

### Phase 7 — Resource Protection

Planned controls:

* File-size limits
* Tool-call rate limiting
* Execution limits
* Timeout enforcement
* Model runaway protection
* Resource exhaustion protection

Security testing will remain a requirement throughout all future phases.

---

## 8. Development Commands

### Development

```bash
npm run dev
```

Runs the local development/integration flow.

### Type Checking

```bash
npm run typecheck
```

Runs TypeScript validation without emitting compiled output.

### Tests

```bash
npm test
```

Runs the complete test suite.

### Build

```bash
npm run build
```

Builds the project for production/distribution as configured by the project.

---

## 9. Security Principles

The following principles guide the architecture:

1. **Treat the LLM as untrusted.**
2. **Never allow the LLM to define its own permissions.**
3. **Centralize tool execution through security boundaries.**
4. **Fail closed whenever validation or authorization cannot be established.**
5. **Keep operations inside the authorized workspace.**
6. **Require explicit human approval for protected operations.**
7. **Validate tool inputs before execution.**
8. **Limit resource consumption and execution frequency.**
9. **Record security-relevant operations for auditability.**
10. **Security controls must be tested before new capabilities are considered complete.**

---

## 10. Project Licensing

Copyright © 2026 Sivaramakrishnan. All rights reserved.

The repository is publicly available for viewing, inspection, evaluation, and verification of the author's work.

Use, copying, modification, distribution, or commercial exploitation of the source code is not permitted without prior written permission from the copyright holder.

See `LICENSE` for the applicable terms.
