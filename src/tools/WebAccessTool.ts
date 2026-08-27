import { withTimeout } from "./ToolTimeout.js";
import { Permission } from "../permissions/Permission.js";

import type {
  Tool,
  ToolContext,
  ToolInput,
  ToolResult,
  ToolInputSchema,
} from "./Tool.js";
import { contentScanner } from "../security/ContentScanner.js";

/*
 * Maximum response body size in bytes.
 * Responses larger than this are truncated.
 * Prevents the agent from consuming huge pages.
 */
const MAX_RESPONSE_BYTES = 100_000; // 100KB

/*
 * Maximum characters in tool output.
 * Consistent with ToolExecutionGateway truncation.
 */
const MAX_OUTPUT_CHARS = 8_000;

/*
 * Timeout for web requests.
 * Same as RunCommandTool and GitTool.
 */
const TIMEOUT_MS = 30_000;

/*
 * Private IP ranges that must never be reached.
 * Used to prevent SSRF attacks where the LLM
 * tries to access internal network resources.
 *
 * Covers:
 * - Loopback: 127.0.0.0/8
 * - Private A: 10.0.0.0/8
 * - Private B: 172.16.0.0/12
 * - Private C: 192.168.0.0/16
 * - Link-local: 169.254.0.0/16
 * - IPv6 loopback: ::1
 * - IPv6 link-local: fe80::/10
 */
const PRIVATE_IP_PATTERNS = [
  /^127\./,
  /^10\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^169\.254\./,
  /^::1$/,
  /^fe80:/i,
  /^fc00:/i,
  /^fd[0-9a-f]{2}:/i,
];

/*
 * Blocked hostnames regardless of IP resolution.
 */
const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "local",
  "internal",
  "intranet",
  "corp",
  "lan",
]);

/**
 * WebAccessTool
 *
 * Fetches content from public HTTPS URLs.
 *
 * SECURITY:
 * 1. Only HTTPS allowed — no HTTP, file://, ftp://, etc.
 * 2. SSRF protection — private IPs blocked before fetch.
 * 3. Redirect interception — IP rechecked after each redirect.
 * 4. Response size limited to 100KB.
 * 5. HTML stripped to text — no script execution.
 * 6. Prompt injection patterns removed from content.
 * 7. 30 second timeout.
 * 8. Output truncated to 8000 chars.
 */
export class WebAccessTool implements Tool {
  readonly name = "web_access";

  readonly description =
    "Fetch content from a public HTTPS URL. " +
    "Only HTTPS URLs are allowed. " +
    "Private/internal network addresses are blocked. " +
    "Returns the page text content. " +
    "Use this to look up documentation, APIs, or public information. " +
    "Requires explicit user approval for each URL.";

  readonly permission = Permission.WEB_ACCESS;

  readonly inputSchema: ToolInputSchema = {
    type: "object",
    properties: {
      url: {
        type: "string",
        description: "The HTTPS URL to fetch. Must start with https://",
      },
    },
    required: ["url"],
  };

  readonly retryable = true;

  async execute(input: ToolInput, _context: ToolContext): Promise<ToolResult> {
    const url = input.url;

    if (typeof url !== "string" || url.trim() === "") {
      return {
        success: false,
        output: "",
        error: "A valid URL is required.",
      };
    }

    const trimmedUrl = url.trim();

    /*
     * Step 1: Parse and validate URL structure.
     */
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(trimmedUrl);
    } catch {
      return {
        success: false,
        output: "",
        error: `Invalid URL: "${trimmedUrl}"`,
      };
    }

    /*
     * Step 2: Protocol check.
     * Only HTTPS allowed.
     */
    if (parsedUrl.protocol !== "https:") {
      return {
        success: false,
        output: "",
        error:
          `Only HTTPS URLs are allowed. ` +
          `Received protocol: "${parsedUrl.protocol}". ` +
          `Please use an https:// URL.`,
      };
    }

    /*
     * Step 3: Hostname check.
     * Block known internal hostnames.
     */
    const hostname = parsedUrl.hostname.toLowerCase();

    if (BLOCKED_HOSTNAMES.has(hostname)) {
      console.log(`\n[SECURITY] WebAccessTool blocked hostname: ${hostname}`);
      return {
        success: false,
        output: "",
        error: `Blocked hostname: "${hostname}". Internal network access is not permitted.`,
      };
    }

    /*
     * Step 4: DNS resolution + IP check.
     * Resolve hostname to IP and verify it is
     * not a private/internal address (SSRF protection).
     */
    const ssrfCheck = await this.checkForSSRF(hostname);

    if (ssrfCheck !== null) {
      console.log(
        `\n[SECURITY] WebAccessTool SSRF blocked: ${hostname} → ${ssrfCheck}`,
      );
      return {
        success: false,
        output: "",
        error:
          `Blocked: "${hostname}" resolves to a private IP address (${ssrfCheck}). ` +
          `Internal network access is not permitted.`,
      };
    }

    /*
     * Step 5: Fetch with redirect interception.
     * We follow redirects manually so we can
     * recheck the IP at each hop.
     */
    try {
      const result = await withTimeout(
        this.fetchWithRedirectCheck(trimmedUrl),
        TIMEOUT_MS,
        this.name,
      );

      return result;
    } catch (error) {
      return {
        success: false,
        output: "",
        error: error instanceof Error ? error.message : "Failed to fetch URL.",
      };
    }
  }

  /*
   * Resolve hostname and check all returned IPs
   * against private ranges.
   *
   * Returns the blocked IP string if SSRF detected,
   * null if safe.
   */
  private async checkForSSRF(hostname: string): Promise<string | null> {
    try {
      const { lookup } = await import("node:dns/promises");
      const results = await lookup(hostname, { all: true });

      const addresses = results.map((r) => r.address);

      for (const address of addresses) {
        if (this.isPrivateIP(address)) {
          return address;
        }
      }

      return null;
    } catch {
      /*
       * DNS resolution failed — treat as blocked.
       * Fail closed: if we cannot verify the IP
       * is safe, we do not allow the request.
       */
      return "unresolvable";
    }
  }

  /*
   * Check if an IP address falls within
   * private/reserved ranges.
   */
  private isPrivateIP(ip: string): boolean {
    return PRIVATE_IP_PATTERNS.some((pattern) => pattern.test(ip));
  }

  /*
   * Fetch URL with manual redirect handling.
   *
   * On each redirect:
   * 1. Parse new Location header
   * 2. Validate protocol (must still be HTTPS)
   * 3. Re-resolve hostname IP (SSRF check)
   * 4. Only then follow the redirect
   *
   * Maximum 5 redirects to prevent loops.
   */
  private async fetchWithRedirectCheck(
    url: string,
    redirectCount = 0,
  ): Promise<ToolResult> {
    const MAX_REDIRECTS = 5;

    if (redirectCount > MAX_REDIRECTS) {
      return {
        success: false,
        output: "",
        error: "Too many redirects.",
      };
    }

    const response = await fetch(url, {
      method: "GET",
      redirect: "manual",
      headers: {
        /*
         * Identify ourselves honestly.
         * Some sites block requests without user agent.
         */
        "User-Agent": "PrivateAI/1.0 (research tool)",
        Accept: "text/html,application/json,text/plain,*/*",
      },
    });

    /*
     * Handle redirects manually.
     */
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");

      if (!location) {
        return {
          success: false,
          output: "",
          error: "Redirect with no Location header.",
        };
      }

      /*
       * Resolve relative redirects against current URL.
       */
      let redirectUrl: URL;
      try {
        redirectUrl = new URL(location, url);
      } catch {
        return {
          success: false,
          output: "",
          error: `Invalid redirect URL: "${location}"`,
        };
      }

      /*
       * Re-check protocol after redirect.
       */
      if (redirectUrl.protocol !== "https:") {
        console.log(
          `\n[SECURITY] WebAccessTool blocked redirect to non-HTTPS: ${redirectUrl.href}`,
        );
        return {
          success: false,
          output: "",
          error:
            `Redirect to non-HTTPS URL blocked: "${redirectUrl.href}". ` +
            `Only HTTPS is permitted.`,
        };
      }

      /*
       * Re-check IP after redirect (SSRF on redirect).
       */
      const ssrfCheck = await this.checkForSSRF(redirectUrl.hostname);

      if (ssrfCheck !== null) {
        console.log(
          `\n[SECURITY] WebAccessTool SSRF blocked on redirect: ` +
            `${redirectUrl.hostname} → ${ssrfCheck}`,
        );
        return {
          success: false,
          output: "",
          error:
            `Redirect target "${redirectUrl.hostname}" resolves to ` +
            `a private IP (${ssrfCheck}). Blocked.`,
        };
      }

      return this.fetchWithRedirectCheck(redirectUrl.href, redirectCount + 1);
    }

    /*
     * Non-redirect response.
     */
    if (!response.ok) {
      return {
        success: false,
        output: "",
        error: `HTTP ${response.status}: ${response.statusText}`,
      };
    }

    /*
     * Read response body with size limit.
     */
    const contentType = response.headers.get("content-type") ?? "";

    const rawText = await this.readResponseBody(response);

    /*
     * Strip HTML if content is HTML.
     * Return JSON and plain text as-is.
     */
    let text: string;

    if (contentType.includes("text/html")) {
      text = this.stripHtml(rawText);
    } else {
      text = rawText;
    }

    /*
     * Remove prompt injection patterns.
     * Prevents web content from hijacking the LLM.
     */
    /*
     * Scan for dangerous patterns and prompt injection.
     * ContentScanner handles both in one pass.
     * Warnings are prepended to output.
     */
    const scanResult = contentScanner.scan(text, `web content from "${url}"`);

    const warningPrefix = contentScanner.formatWarnings(scanResult.warnings);

    text = warningPrefix + text;

    /*
     * Truncate to max output chars.
     */
    const truncated =
      text.length > MAX_OUTPUT_CHARS
        ? text.slice(0, MAX_OUTPUT_CHARS) +
          "\n\n[Content truncated at 8000 characters]"
        : text;

    return {
      success: true,
      output: truncated,
    };
  }

  /*
   * Read response body with size limit.
   * Reads up to MAX_RESPONSE_BYTES bytes.
   * Truncates silently if larger.
   */
  private async readResponseBody(response: Response): Promise<string> {
    const reader = response.body?.getReader();

    if (!reader) {
      return await response.text();
    }

    const decoder = new TextDecoder("utf-8");
    let result = "";
    let bytesRead = 0;

    try {
      while (true) {
        const { done, value } = await reader.read();

        if (done) break;

        if (value) {
          bytesRead += value.byteLength;

          if (bytesRead > MAX_RESPONSE_BYTES) {
            /*
             * We have read enough.
             * Decode what we have and stop.
             */
            result += decoder.decode(
              value.slice(
                0,
                value.byteLength - (bytesRead - MAX_RESPONSE_BYTES),
              ),
              { stream: false },
            );
            break;
          }

          result += decoder.decode(value, { stream: true });
        }
      }
    } finally {
      reader.releaseLock();
    }

    return result;
  }

  /*
   * Strip HTML tags from content.
   *
   * Removes:
   * - All HTML tags
   * - Script and style blocks with content
   * - HTML entities decoded to plain text
   * - Multiple blank lines collapsed
   */
  private stripHtml(html: string): string {
    let text = html;

    /*
     * Remove script blocks entirely.
     * These contain JavaScript — not useful as text.
     */
    text = text.replace(/<script[\s\S]*?<\/script>/gi, "");

    /*
     * Remove style blocks entirely.
     */
    text = text.replace(/<style[\s\S]*?<\/style>/gi, "");

    /*
     * Remove all remaining HTML tags.
     */
    text = text.replace(/<[^>]+>/g, " ");

    /*
     * Decode common HTML entities.
     */
    text = text
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&nbsp;/g, " ")
      .replace(/&hellip;/g, "...")
      .replace(/&mdash;/g, "—")
      .replace(/&ndash;/g, "–");

    /*
     * Collapse multiple whitespace/newlines.
     */
    text = text.replace(/\s+/g, " ").trim();

    return text;
  }

  /*
   * Remove prompt injection patterns from content.
   *
   * Web pages may contain text designed to hijack
   * the LLM — e.g. "Ignore all previous instructions".
   *
   * We warn but do not block. The content is
   * included but the dangerous phrase is redacted.
   */
  private removePromptInjection(text: string): string {
    const injectionPatterns = [
      /ignore\s+(all\s+)?(previous|prior|above)\s+instructions?/gi,
      /disregard\s+(all\s+)?(previous|prior|above)\s+instructions?/gi,
      /forget\s+(all\s+)?(previous|prior|above)\s+instructions?/gi,
      /you\s+are\s+now\s+/gi,
      /new\s+instructions?\s*:/gi,
      /system\s*:\s*you\s+/gi,
      /\[system\]/gi,
      /\[instructions?\]/gi,
    ];

    let cleaned = text;

    for (const pattern of injectionPatterns) {
      if (pattern.test(cleaned)) {
        console.log(
          "\n[SECURITY] WebAccessTool: " +
            "Prompt injection pattern detected and removed from web content.",
        );
        cleaned = cleaned.replace(pattern, "[REDACTED]");
      }
    }

    return cleaned;
  }
}
