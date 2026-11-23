import { NextResponse } from "next/server";
import { z } from "zod";
import { syncAppointment } from "@/lib/payments/service";
import { createPublicClient } from "@/lib/supabase/public";

export const maxDuration = 30;

const Body = z.object({ token: z.string().uuid() });

// A página do cliente chama enquanto espera o pagamento (e depois de cancelar): confere no provedor,
// libera reserva vencida e faz estorno pendente. A resposta não traz dados; a página relê pelo link.
export async function POST(request: Request) {
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Requisição inválida." }, { status: 400 });
  try {
    await syncAppointment(createPublicClient(), parsed.data.token);
  } catch (error) {
    console.error("pagamento/status", (error as Error).message);
  }
  return NextResponse.json({ ok: true });
}
