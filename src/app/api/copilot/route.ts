import { NextResponse } from "next/server";
import { z } from "zod";
import { runCopilot } from "@/lib/ai/copilot";
import { aiErrorResponse } from "@/lib/ai/errors";
import { requireOwner } from "@/lib/ai/owner";
import { fetchCatalog } from "@/lib/data";
import { timeInSaoPaulo, todayInSaoPaulo } from "@/lib/dates";

export const maxDuration = 60;

const Body = z.object({
  messages: z
    .array(z.object({ role: z.enum(["user", "assistant"]), content: z.string().min(1).max(4000) }))
    .min(1)
    .max(40),
});

export async function POST(request: Request) {
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success || parsed.data.messages[parsed.data.messages.length - 1].role !== "user") {
    return NextResponse.json({ error: "Requisição inválida." }, { status: 400 });
  }
  const owner = await requireOwner();
  if ("error" in owner) return owner.error;
  const { supabase, business } = owner;

  try {
    const now = new Date();
    const result = await runCopilot({
      supabase,
      catalog: await fetchCatalog(supabase, business),
      history: parsed.data.messages,
      today: todayInSaoPaulo(now),
      nowTime: timeInSaoPaulo(now.toISOString()),
    });
    return NextResponse.json(result);
  } catch (error) {
    return aiErrorResponse(error, "copilot");
  }
}
