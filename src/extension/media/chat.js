// @ts-check
"use strict";

(function () {
    // @ts-ignore
    const vscode = acquireVsCodeApi();

    const messagesEl = document.getElementById("messages");
    const inputEl = document.getElementById("user-input");
    const sendBtn = document.getElementById("send-btn");
    const autocompleteList = document.getElementById("autocomplete-list");

    let isStreaming = false;
    let currentAssistantEl = null;
    let currentContentEl = null;
    let cursorEl = null;
    let thinkingEl = null;
    let firstTokenReceived = false;

    /*
     * Track timing for chat bubble display.
     */
    let messageStartTime = 0;
    let toolCount = 0;

    /*
     * Autocomplete state.
     */
    let autocompleteActive = false;
    let selectedIndex = -1;

    /* ─────────────────────────────────────────
     * Message rendering
     * ───────────────────────────────────────── */

    function addMessage(role, text) {
        const msgDiv = document.createElement("div");
        msgDiv.className = `message message-${role}`;

        if (role !== "system") {
            const header = document.createElement("div");
            header.className = "message-header";

            const label = document.createElement("span");
            label.className = "message-label";
            label.textContent = role === "user" ? "You" : "Assistant";
            header.appendChild(label);

            /*
             * Right side of header: timestamp + copy button.
             * Grouped so they don't overlap.
             */
            const headerRight = document.createElement("div");
            headerRight.className = "message-header-right";

            const time = document.createElement("span");
            time.className = "message-time";
            time.textContent = formatTime(new Date());
            headerRight.appendChild(time);

            if (role === "user" || role === "assistant") {
                const copyBtn = document.createElement("button");
                copyBtn.className = "message-copy-btn";
                copyBtn.title = "Copy message";
                copyBtn.textContent = "Copy";
                copyBtn.addEventListener("click", function () {
                    const textToCopy =
                        msgDiv.dataset.finalText ||
                        content.textContent ||
                        "";
                    navigator.clipboard.writeText(textToCopy).then(function () {
                        copyBtn.textContent = "Copied";
                        copyBtn.classList.add("copied");
                        setTimeout(function () {
                            copyBtn.textContent = "Copy";
                            copyBtn.classList.remove("copied");
                        }, 1500);
                    });
                });
                headerRight.appendChild(copyBtn);
            }

            header.appendChild(headerRight);
            msgDiv.appendChild(header);
        }

        const content = document.createElement("div");
        content.className = "message-content";
        renderContent(content, text);
        msgDiv.appendChild(content);

        /*
         * Store the raw text on the DOM element so copy
         * button can retrieve the ORIGINAL (untruncated,
         * un-rendered) text later.
         */
        msgDiv.dataset.finalText = text;

        messagesEl.appendChild(msgDiv);

        scrollToBottom();

        return content;
    }

    /*
     * Format time as 12-hour clock: "5:15 PM"
     */
    function formatTime(date) {
        let hours = date.getHours();
        const minutes = date.getMinutes();
        const ampm = hours >= 12 ? "PM" : "AM";
        hours = hours % 12;
        if (hours === 0) hours = 12;
        const mm = minutes < 10 ? "0" + minutes : String(minutes);
        return hours + ":" + mm + " " + ampm;
    }

    /*
     * Render text with code block support.
     * Detects ```lang\ncode\n``` blocks and renders
     * them with syntax-styled boxes and copy buttons.
     */
    function renderContent(container, text) {
        const parts = text.split(/(```[\s\S]*?```)/g);

        for (const part of parts) {
            if (part.startsWith("```") && part.endsWith("```")) {
                container.appendChild(buildCodeBlock(part));
            } else if (part !== "") {
                const textNode = document.createTextNode(part);
                container.appendChild(textNode);
            }
        }
    }

    /*
     * Build a code block with header, copy button.
     */
    function buildCodeBlock(rawBlock) {
        const inner = rawBlock.slice(3, -3);
        const newlineIdx = inner.indexOf("\n");

        let lang = "";
        let code = inner;

        if (newlineIdx !== -1) {
            const potentialLang = inner.slice(0, newlineIdx).trim();
            if (/^[a-zA-Z0-9]+$/.test(potentialLang)) {
                lang = potentialLang;
                code = inner.slice(newlineIdx + 1);
            }
        }

        code = code.replace(/\n$/, "");

        const wrapper = document.createElement("div");
        wrapper.className = "code-block-wrapper";

        const header = document.createElement("div");
        header.className = "code-block-header";

        const langLabel = document.createElement("span");
        langLabel.className = "code-block-lang";
        langLabel.textContent = lang || "code";
        header.appendChild(langLabel);

        const copyBtn = document.createElement("button");
        copyBtn.className = "copy-btn";
        copyBtn.textContent = "Copy";
        copyBtn.addEventListener("click", function () {
            navigator.clipboard.writeText(code).then(function () {
                copyBtn.textContent = "Copied ✓";
                copyBtn.classList.add("copied");
                setTimeout(function () {
                    copyBtn.textContent = "Copy";
                    copyBtn.classList.remove("copied");
                }, 1500);
            });
        });
        header.appendChild(copyBtn);

        wrapper.appendChild(header);

        const pre = document.createElement("pre");
        const codeEl = document.createElement("code");
        codeEl.textContent = code;
        pre.appendChild(codeEl);
        wrapper.appendChild(pre);

        return wrapper;
    }

    function addTimingFooter(durationMs, tools) {
        if (!currentAssistantEl) return;

        const footer = document.createElement("div");
        footer.className = "message-timing";

        const seconds = (durationMs / 1000).toFixed(1);
        let text = `${seconds}s`;

        if (tools > 0) {
            text += ` • ${tools} tool${tools > 1 ? "s" : ""}`;
        }

        footer.textContent = text;
        currentAssistantEl.appendChild(footer);
    }

    /* ─────────────────────────────────────────
     * Streaming
     * ───────────────────────────────────────── */

    function startStreaming() {
        const msgDiv = document.createElement("div");
        msgDiv.className = "message message-assistant";

        const header = document.createElement("div");
        header.className = "message-header";

        const label = document.createElement("span");
        label.className = "message-label";
        label.textContent = "Assistant";
        header.appendChild(label);

        const headerRight = document.createElement("div");
        headerRight.className = "message-header-right";

        const time = document.createElement("span");
        time.className = "message-time";
        time.textContent = formatTime(new Date());
        headerRight.appendChild(time);

        const copyBtn = document.createElement("button");
        copyBtn.className = "message-copy-btn";
        copyBtn.title = "Copy message";
        copyBtn.textContent = "Copy";
        copyBtn.addEventListener("click", function () {
            const textToCopy =
                msgDiv.dataset.finalText ||
                (currentContentEl && currentContentEl.textContent) ||
                "";
            navigator.clipboard.writeText(textToCopy).then(function () {
                copyBtn.textContent = "Copied";
                copyBtn.classList.add("copied");
                setTimeout(function () {
                    copyBtn.textContent = "Copy";
                    copyBtn.classList.remove("copied");
                }, 1500);
            });
        });
        headerRight.appendChild(copyBtn);

        header.appendChild(headerRight);
        msgDiv.appendChild(header);

        const content = document.createElement("div");
        content.className = "message-content";
        msgDiv.appendChild(content);

        /*
         * Show thinking dots until first token arrives.
         * Once tokens start, dots are replaced with content.
         */
        thinkingEl = document.createElement("span");
        thinkingEl.className = "thinking-dots";
        thinkingEl.innerHTML =
            "<span></span><span></span><span></span>";
        content.appendChild(thinkingEl);

        messagesEl.appendChild(msgDiv);
        scrollToBottom();

        currentAssistantEl = msgDiv;
        currentContentEl = content;
        isStreaming = true;
        firstTokenReceived = false;

    }

    function appendToken(token) {
        if (!currentContentEl) return;

        /*
         * First token: remove thinking dots, add cursor.
         */
        if (!firstTokenReceived) {
            firstTokenReceived = true;
            if (thinkingEl) {
                thinkingEl.remove();
                thinkingEl = null;
            }
            cursorEl = document.createElement("span");
            cursorEl.className = "streaming-cursor";
            currentContentEl.appendChild(cursorEl);
        }

        if (!cursorEl) return;

        const textNode = document.createTextNode(token);
        currentContentEl.insertBefore(textNode, cursorEl);
        scrollToBottom();
    }

    function endStreaming() {
        /*
         * Remove thinking dots if still visible.
         */
        if (thinkingEl) {
            thinkingEl.remove();
            thinkingEl = null;
        }

        /*
         * Remove cursor.
         */
        if (cursorEl) {
            cursorEl.remove();
            cursorEl = null;
        }

        /*
         * Re-render final content with code block support.
         * The streamed content is plain text — we now
         * check if it contains code blocks and re-render.
         */
        if (currentContentEl) {
            const finalText = currentContentEl.textContent || "";
            /*
             * Store final text on message div for copy button.
             */
            if (currentAssistantEl) {
                currentAssistantEl.dataset.finalText = finalText;
            }
            if (finalText.includes("```")) {
                currentContentEl.innerHTML = "";
                renderContent(currentContentEl, finalText);
            }
        }

        /*
         * Add timing footer.
         */
        if (messageStartTime > 0) {
            const durationMs = Date.now() - messageStartTime;
            addTimingFooter(durationMs, toolCount);
        }

        currentAssistantEl = null;
        currentContentEl = null;
        isStreaming = false;
        firstTokenReceived = false;
    }

    /* ─────────────────────────────────────────
     * Textarea auto-grow
     * ───────────────────────────────────────── */

    function autoResizeTextarea() {
        inputEl.style.height = "auto";
        const maxHeight = 250;
        const newHeight = Math.min(inputEl.scrollHeight, maxHeight);
        inputEl.style.height = newHeight + "px";
    }

    function resetTextareaHeight() {
        inputEl.style.height = "auto";
    }

    /* ─────────────────────────────────────────
     * Send message
     * ───────────────────────────────────────── */

    function sendMessage() {
        const text = inputEl.value.trim();
        if (text === "" || isStreaming) return;

        addMessage("user", text);
        inputEl.value = "";
        resetTextareaHeight();

        switchToStopButton();

        messageStartTime = Date.now();
        toolCount = 0;

        /*
         * Slash commands don't produce assistant responses.
         * They return system messages directly. Don't create
         * an empty assistant bubble for them.
         */
        if (!text.startsWith("/")) {
            startStreaming();
        }

        vscode.postMessage({
            type: "chat",
            text: text,
        });
    }

    /*
     * Switch Send button to Stop button while agent runs.
     */
    function switchToStopButton() {
        sendBtn.textContent = "Stop";
        sendBtn.classList.add("stop-btn");
        sendBtn.disabled = false;
        isStreaming = true;
    }

    /*
     * Restore Send button after agent finishes.
     */
    function switchToSendButton() {
        sendBtn.textContent = "Send";
        sendBtn.classList.remove("stop-btn");
        sendBtn.disabled = false;
        isStreaming = false;
    }

    /*
     * Handle Send/Stop button click.
     */
    function onSendClick() {
        if (isStreaming) {
            /*
             * Currently running — send stop signal.
             */
            vscode.postMessage({ type: "stop" });
            return;
        }
        sendMessage();
    }

    sendBtn.addEventListener("click", onSendClick);

    /* ─────────────────────────────────────────
     * Scroll helper
     * ───────────────────────────────────────── */

    function scrollToBottom() {
        messagesEl.scrollTop = messagesEl.scrollHeight;
    }

    /* ─────────────────────────────────────────
     * @ File and / Slash autocomplete
     * ───────────────────────────────────────── */

    function checkForMention() {
        const text = inputEl.value;
        const cursorPos = inputEl.selectionStart;
        const beforeCursor = text.slice(0, cursorPos);

        const slashMatch = beforeCursor.match(/(?:^|\n)(\/\w*)$/);
        if (slashMatch) {
            showSlashCommands(slashMatch[1]);
            autocompleteActive = true;
            return;
        }

        const atIndex = beforeCursor.lastIndexOf("@");

        if (atIndex === -1) {
            hideAutocomplete();
            return;
        }

        const afterAt = beforeCursor.slice(atIndex + 1);
        if (afterAt.includes(" ") || afterAt.includes("\n")) {
            hideAutocomplete();
            return;
        }

        vscode.postMessage({
            type: "fileComplete",
            text: afterAt,
        });
        autocompleteActive = true;
    }

    function showSlashCommands(partial) {
        const commands = [
            { name: "/help", desc: "Show command list" },
            { name: "/clear", desc: "Clear conversation" },
            { name: "/stats", desc: "Session metrics" },
            { name: "/audit", desc: "Recent security events" },
            { name: "/memory", desc: "Show project memory" },
            { name: "/remember", desc: "Save a fact" },
            { name: "/forget", desc: "Remove a fact" },
            { name: "/save", desc: "Save session as JSON" },
            { name: "/export", desc: "Save session as Markdown" },
        ];

        const filtered = commands.filter(function (c) {
            return c.name.startsWith(partial.toLowerCase());
        });

        if (filtered.length === 0) {
            hideAutocomplete();
            return;
        }

        selectedIndex = -1;
        autocompleteList.innerHTML = "";

        for (const cmd of filtered) {
            const item = document.createElement("div");
            item.className = "autocomplete-item";
            item.textContent = `${cmd.name} — ${cmd.desc}`;
            item.dataset.value = cmd.name;
            item.addEventListener("click", function () {
                insertSlashCommand(cmd.name);
            });
            autocompleteList.appendChild(item);
        }

        autocompleteList.classList.remove("autocomplete-hidden");
    }

    function insertSlashCommand(command) {
        const text = inputEl.value;
        const cursorPos = inputEl.selectionStart;
        const beforeCursor = text.slice(0, cursorPos);
        const slashMatch = beforeCursor.match(/(?:^|\n)(\/\w*)$/);

        if (!slashMatch) return;

        const matchStart = beforeCursor.lastIndexOf(slashMatch[1]);
        const afterCursor = text.slice(cursorPos);
        const newText =
            text.slice(0, matchStart) + command + " " + afterCursor;

        inputEl.value = newText;
        const newPos = matchStart + command.length + 1;
        inputEl.selectionStart = newPos;
        inputEl.selectionEnd = newPos;
        inputEl.focus();
        autoResizeTextarea();

        hideAutocomplete();
    }

    function hideAutocomplete() {
        autocompleteList.classList.add("autocomplete-hidden");
        autocompleteActive = false;
        selectedIndex = -1;
    }

    function showSuggestions(files) {
        selectedIndex = -1;
        if (!files || files.length === 0) {
            hideAutocomplete();
            return;
        }

        autocompleteList.innerHTML = "";

        for (const file of files) {
            const item = document.createElement("div");
            item.className = "autocomplete-item";
            item.textContent = file;
            item.addEventListener("click", function () {
                insertMention(file);
            });
            autocompleteList.appendChild(item);
        }

        autocompleteList.classList.remove("autocomplete-hidden");
    }

    function insertMention(file) {
        const text = inputEl.value;
        const cursorPos = inputEl.selectionStart;
        const beforeCursor = text.slice(0, cursorPos);
        const atIndex = beforeCursor.lastIndexOf("@");

        if (atIndex === -1) return;

        const afterCursor = text.slice(cursorPos);
        const newText =
            text.slice(0, atIndex) + "@" + file + " " + afterCursor;
        inputEl.value = newText;

        const newPos = atIndex + file.length + 2;
        inputEl.selectionStart = newPos;
        inputEl.selectionEnd = newPos;
        inputEl.focus();
        autoResizeTextarea();

        hideAutocomplete();
    }

    /* ─────────────────────────────────────────
     * Input event handlers
     * ───────────────────────────────────────── */

    inputEl.addEventListener("input", function () {
        autoResizeTextarea();
        checkForMention();
    });

    inputEl.addEventListener("keydown", function (e) {
        if (autocompleteActive) {
            const items =
                autocompleteList.querySelectorAll(".autocomplete-item");

            if (e.key === "Escape") {
                e.preventDefault();
                hideAutocomplete();
                return;
            }

            if (e.key === "ArrowDown") {
                e.preventDefault();
                selectedIndex = Math.min(
                    selectedIndex + 1,
                    items.length - 1,
                );
                updateSelection(items);
                return;
            }

            if (e.key === "ArrowUp") {
                e.preventDefault();
                selectedIndex = Math.max(selectedIndex - 1, 0);
                updateSelection(items);
                return;
            }

            if (e.key === "Enter" && selectedIndex >= 0) {
                e.preventDefault();
                const selected = items[selectedIndex];
                if (selected) {
                    const value =
                        selected.dataset.value || selected.textContent;
                    if (value.startsWith("/")) {
                        insertSlashCommand(value);
                    } else {
                        insertMention(value);
                    }
                }
                return;
            }

            if (e.key === "Tab" && items.length > 0) {
                e.preventDefault();
                const target =
                    selectedIndex >= 0
                        ? items[selectedIndex]
                        : items[0];
                if (target) {
                    const value =
                        target.dataset.value || target.textContent;
                    if (value.startsWith("/")) {
                        insertSlashCommand(value);
                    } else {
                        insertMention(value);
                    }
                }
                return;
            }
        }

        if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            sendMessage();
        }
    });

    function updateSelection(items) {
        for (let i = 0; i < items.length; i++) {
            if (i === selectedIndex) {
                items[i].style.backgroundColor =
                    "var(--vscode-editorSuggestWidget-selectedBackground)";
            } else {
                items[i].style.backgroundColor = "";
            }
        }
    }

    /* ─────────────────────────────────────────
     * Messages from extension
     * ───────────────────────────────────────── */

    window.addEventListener("message", function (event) {
        const msg = event.data;

        switch (msg.type) {
            case "token":
                appendToken(msg.text);
                break;

            case "done":
                /*
                 * Only end streaming if an assistant bubble was created.
                 * Slash commands skip startStreaming so no bubble exists.
                 */
                if (currentAssistantEl !== null) {
                    endStreaming();
                } else {
                    /*
                     * Reset streaming state manually since endStreaming
                     * won't be called for slash commands.
                     */
                    isStreaming = false;
                }
                switchToSendButton();
                inputEl.focus();
                break;

            case "error":
                endStreaming();
                addMessage("system", "✗ " + msg.text);
                switchToSendButton();
                inputEl.focus();
                break;

            case "system":
                addMessage("system", msg.text);
                break;

            case "clear":
                messagesEl.innerHTML = "";
                addMessage("system", "Conversation cleared.");
                break;

            case "fileSuggestions":
                showSuggestions(msg.files);
                break;

            case "prefill":
                /*
                 * External command wants to fill the input textarea.
                 * User can then edit and press Send, or command may
                 * auto-send by calling handleChat separately.
                 */
                inputEl.value = msg.text;
                autoResizeTextarea();
                inputEl.focus();
                /*
                 * Put cursor at the end.
                 */
                inputEl.setSelectionRange(msg.text.length, msg.text.length);
                break;
            case "externalMessage":
                /*
                 * Extension-initiated message (context menu commands).
                 * Behave exactly like user typed + pressed Enter,
                 * but without needing to touch the input textarea.
                 */
                addMessage("user", msg.text);
                switchToStopButton();
                messageStartTime = Date.now();
                toolCount = 0;
                startStreaming();
                break;
        }
    });

    inputEl.focus();
    autoResizeTextarea();
})();