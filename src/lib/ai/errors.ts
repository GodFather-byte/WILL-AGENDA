import Anthropic from "@anthropic-ai/sdk";
import { NextResponse } from "next/server";

/** Converte erros da API de IA em respostas HTTP com mensagem em português. */
export function aiErrorResponse(error: unknown, context: string) {
  if (error instanceof Anthropic.RateLimitError) {
    return NextResponse.json({ error: "Limite de uso da IA atingido. Tente em instantes." }, { status: 429 });
  }
  if (error instanceof Anthropic.APIError) {
    console.error(`${context} API error`, error.status, error.message);
    return NextResponse.json({ error: "A IA está indisponível no momento." }, { status: 502 });
  }
  console.error(`${context} error`, error instanceof Error ? error.message : error);
  return NextResponse.json({ error: "A IA está indisponível no momento." }, { status: 500 });
}

export function textOf(message: { content: { type: string }[]; stop_reason: string | null }) {
  if (message.stop_reason === "refusal") return "";
  return message.content
    .filter((block): block is { type: "text"; text: string } => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();
}
