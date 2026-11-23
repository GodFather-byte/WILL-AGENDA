import Anthropic from "@anthropic-ai/sdk";

export const AI_MODEL = process.env.ANTHROPIC_MODEL || "claude-opus-5-5";

/** O Haiku não aceita o modelo reserva do lado do servidor; os demais modelos atuais aceitam. */
export const AI_SUPPORTS_FALLBACK = !AI_MODEL.includes("haiku");

/** Parâmetros do modelo reserva: só entram na chamada para modelos que aceitam. */
export const FALLBACK_PARAMS = AI_SUPPORTS_FALLBACK
  ? { betas: ["server-side-fallback-2026-07-01" as const], fallbacks: "default" as const }
  : {};

let client: Anthropic | null = null;

/** Credenciais vêm do ambiente (ANTHROPIC_API_KEY). */
export function anthropic() {
  client ??= new Anthropic();
  return client;
}

export const aiConfigured = () => Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
