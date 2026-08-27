/*
 * OllamaHealthCheck
 *
 * Verifies Ollama is running and the required
 * model is available before starting the agent.
 *
 * Gives clear error messages instead of cryptic
 * connection refused errors during inference.
 */
export class OllamaHealthCheck {
  constructor(
    private readonly baseUrl: string,
    private readonly model: string,
    private readonly fallbackModel = "",
  ) {}

  async check(): Promise<void> {
    /*
     * Step 1: Check Ollama is running.
     */
    try {
      const response = await fetch(
        `${this.baseUrl}/api/tags`,
        { signal: AbortSignal.timeout(5000) },
      );

      if (!response.ok) {
        throw new Error(
          `Ollama returned ${response.status}`,
        );
      }
    } catch {
      throw new Error(
        `Cannot connect to Ollama at ${this.baseUrl}.\n` +
        `Please ensure Ollama is running:\n` +
        `  ollama serve\n` +
        `Or check if it is already running in the background.`,
      );
    }

    /*
     * Step 2: Check the required model exists.
     */
    try {
      const response = await fetch(
        `${this.baseUrl}/api/tags`,
      );

      const data = await response.json() as {
        models?: Array<{ name: string }>;
      };

      const models = data.models ?? [];

      const modelExists = models.some(
        (m) =>
          m.name === this.model ||
          m.name.startsWith(
            this.model.split(":")[0] ?? "",
          ),
      );

      if (!modelExists) {
        const available = models
          .map((m) => m.name)
          .join(", ");

        throw new Error(
          `Model '${this.model}' not found in Ollama.\n` +
          `Available models: ${available || "none"}\n` +
          `Pull the model with:\n` +
          `  ollama pull ${this.model}`,
        );
      }
    } catch (error) {
      if (error instanceof Error) {
        throw error;
      }
      throw new Error("Failed to verify model availability.");
    }

    console.log(
      `✓ Ollama connected. Model '${this.model}' ready.`,
    );
  }
}