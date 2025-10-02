import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { LangfuseSpanProcessor } from "@langfuse/otel";
import { setLangfuseTracerProvider } from "@langfuse/tracing";

type LangfuseTracingState = {
  provider: NodeTracerProvider;
  processor: LangfuseSpanProcessor;
};

let state: LangfuseTracingState | undefined;

export function initLangfuseTracing(): LangfuseTracingState {
  if (state) {
    return state;
  }

  const publicKey = process.env.LANGFUSE_PUBLIC_KEY;
  const secretKey = process.env.LANGFUSE_SECRET_KEY;
  const baseUrl = process.env.LANGFUSE_BASE_URL;

  if (!publicKey || !secretKey || !baseUrl) {
    throw new Error(
      "Langfuse tracing requires LANGFUSE_PUBLIC_KEY, LANGFUSE_SECRET_KEY, and LANGFUSE_BASE_URL to be set"
    );
  }

  const processor = new LangfuseSpanProcessor({
    publicKey,
    secretKey,
    baseUrl,
    exportMode: "immediate",
  });

  const provider = new NodeTracerProvider({
    spanProcessors: [processor],
  });

  // Register provider only for Langfuse, to avoid interfering with Trigger.dev's tracer
  setLangfuseTracerProvider(provider);

  state = { provider, processor };

  const flush = async () => {
    try {
      await processor.forceFlush();
    } catch (error) {
      console.error("Failed to flush Langfuse spans", error);
    }
  };

  process.once("beforeExit", flush);
  process.once("exit", flush);
  process.once("SIGINT", async () => {
    await flush();
    process.exit(130);
  });
  process.once("SIGTERM", async () => {
    await flush();
    process.exit(143);
  });
  return state;
}

export async function flushLangfuseTracing(): Promise<void> {
  if (!state) {
    return;
  }

  await state.processor.forceFlush();
}
