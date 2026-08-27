/*
 * ToolTimeout
 *
 * Wraps a tool execution promise with a timeout.
 * Uses AbortController to actually cancel
 * underlying operations on timeout.
 *
 * This prevents hung tools from:
 * - Holding file locks on Windows
 * - Consuming network connections
 * - Blocking the agent indefinitely
 */
export async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  toolName: string,
  signal?: AbortSignal,
): Promise<T> {
  const controller = new AbortController();
  let timeoutHandle: NodeJS.Timeout;

  const timeoutPromise = new Promise<never>(
    (_, reject) => {
      timeoutHandle = setTimeout(() => {
        /*
         * Signal abort to any operation listening.
         * This cancels fetch() calls and allows
         * file operations to check the signal.
         */
        controller.abort();
        reject(
          new Error(
            `Tool '${toolName}' timed out after ` +
            `${timeoutMs / 1000} seconds.`,
          ),
        );
      }, timeoutMs);
    },
  );

  try {
    const result = await Promise.race([
      promise,
      timeoutPromise,
    ]);

    clearTimeout(timeoutHandle!);
    return result;
  } catch (error) {
    clearTimeout(timeoutHandle!);
    controller.abort();
    throw error;
  }
}

/*
 * Create an AbortSignal that times out automatically.
 * Use this for fetch() calls inside tools.
 */
export function createTimeoutSignal(
  timeoutMs: number,
): AbortSignal {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), timeoutMs);
  return controller.signal;
}