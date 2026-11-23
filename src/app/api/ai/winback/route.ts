import { NextResponse } from "next/server";
import { z } from "zod";
import { AI_MODEL, anthropic, FALLBACK_PARAMS } from "@/lib/ai/client";
import { aiErrorResponse, textOf } from "@/lib/ai/errors";
import { requireOwner } from "@/lib/ai/owner";
import { SEGMENT_LABEL } from "@/lib/format";

export const maxDuration = 30;

const Body = z.object({
  name: z.string().min(1).max(80),
  favorite: z.string().max(100).default(""),
  visits: z.number().int().min(0).max(10000),
  daysAway: z.number().int().min(0).max(3650),
});

// Mensagem de reconquista: a IA escreve, o dono revisa e envia do próprio WhatsApp.
export async function POST(request: Request) {
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Requisição inválida." }, { status: 400 });
  const owner = await requireOwner();
  if ("error" in owner) return owner.error;
  const { business } = owner;
  const { name, favorite, visits, daysAway } = parsed.data;

  const instructions = `Você escreve, em nome de "${business.name}" (${SEGMENT_LABEL[business.segment].toLowerCase()}), uma mensagem de WhatsApp para um cliente que já foi atendido e está há um tempo sem marcar horário. Quem envia é o dono, do próprio WhatsApp, então a mensagem precisa soar como uma pessoa escrevendo, não como propaganda.

Escreva de duas a quatro frases curtas, em português do Brasil: cumprimente pelo primeiro nome, lembre do serviço que a pessoa costuma fazer se ele foi informado, e convide a marcar um horário pelo link {link} (escreva exatamente {link}, que o sistema troca pelo endereço da página). Não prometa desconto, brinde ou vaga, porque o dono não informou nenhum. Não diga há quantos dias a pessoa não vem e não mencione faltas. Não faça nenhuma referência a saúde, tratamento, resultado ou aparência da pessoa. No máximo um emoji. Responda apenas com a mensagem.`;

  try {
    const message = await anthropic().beta.messages.create({
      model: AI_MODEL,
      max_tokens: 4000,
      output_config: { effort: "low" },
      ...FALLBACK_PARAMS,
      system: instructions,
      messages: [
        {
          role: "user",
          content: `Cliente: ${name}\nAtendimentos já feitos: ${visits}\nServiço que mais faz: ${favorite || "não identificado"}\nDias desde o último atendimento: ${daysAway}`,
        },
      ],
    });
    const text = textOf(message);
    if (!text) return NextResponse.json({ error: "Não consegui escrever a mensagem." }, { status: 422 });
    const origin = new URL(request.url).origin;
    return NextResponse.json({ message: text.replaceAll("{link}", `${origin}/${business.slug}`) });
  } catch (error) {
    return aiErrorResponse(error, "winback");
  }
}
