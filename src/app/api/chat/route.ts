import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { z } from "zod";
import { runAttendant } from "@/lib/ai/attendant";
import { aiConfigured } from "@/lib/ai/client";
import { aiErrorResponse } from "@/lib/ai/errors";
import { bookableCatalog, fetchBusinessBySlug, fetchCatalog } from "@/lib/data";
import { timeInSaoPaulo, todayInSaoPaulo } from "@/lib/dates";
import { createPublicClient } from "@/lib/supabase/public";

export const maxDuration = 60;

const Body = z.object({
  slug: z.string().min(1).max(60),
  messages: z
    .array(z.object({ role: z.enum(["user", "assistant"]), content: z.string().min(1).max(2000) }))
    .min(1)
    .max(40),
  // Links secretos dos agendamentos feitos neste aparelho.
  tokens: z.array(z.string().uuid()).max(5).default([]),
});

export async function POST(request: Request) {
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Requisição inválida." }, { status: 400 });
  const body = parsed.data;
  if (body.messages[body.messages.length - 1].role !== "user") {
    return NextResponse.json({ error: "Requisição inválida." }, { status: 400 });
  }
  if (!aiConfigured()) {
    return NextResponse.json({ error: "O atendente de IA ainda não foi configurado nesta instalação." }, { status: 503 });
  }

  const supabase = createPublicClient();
  const business = await fetchBusinessBySlug(supabase, body.slug);
  if (!business) return NextResponse.json({ error: "Estabelecimento não encontrado." }, { status: 404 });
  if (!business.ai_enabled) {
    return NextResponse.json({ error: "Este estabelecimento não usa o atendente virtual." }, { status: 403 });
  }

  // Teto de uso por cliente e por estabelecimento. O IP é guardado apenas como hash.
  // Na Vercel, x-vercel-forwarded-for e x-real-ip são preenchidos pela plataforma (não pelo visitante).
  const ip =
    request.headers.get("x-vercel-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip")?.trim() ||
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    "desconhecido";
  const client = createHash("sha256").update(ip).digest("hex").slice(0, 32);
  const { data: allowed, error: rateError } = await supabase.rpc("ai_rate_hit", {
    p_business_id: business.id,
    p_client: client,
  });
  if (rateError) console.error("rate limit error", rateError.message);
  if (allowed === false) {
    return NextResponse.json(
      { error: "Muitas mensagens em pouco tempo. Aguarde alguns minutos ou agende pela página." },
      { status: 429 },
    );
  }

  try {
    const now = new Date();
    const result = await runAttendant({
      supabase,
      catalog: bookableCatalog(await fetchCatalog(supabase, business)),
      history: body.messages,
      tokens: body.tokens,
      today: todayInSaoPaulo(now),
      nowTime: timeInSaoPaulo(now.toISOString()),
    });
    return NextResponse.json(result);
  } catch (error) {
    return aiErrorResponse(error, "attendant");
  }
}
