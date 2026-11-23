import { NextResponse } from "next/server";
import { z } from "zod";
import { PaymentError, startPayment } from "@/lib/payments/service";
import { createPublicClient } from "@/lib/supabase/public";

export const maxDuration = 30;

const Body = z.object({ token: z.string().uuid() });

// Cria a cobrança Pix do sinal para o agendamento do link secreto. Só existe com a cobrança ligada.
export async function POST(request: Request) {
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Requisição inválida." }, { status: 400 });
  try {
    const payment = await startPayment(createPublicClient(), parsed.data.token, new URL(request.url).origin);
    return NextResponse.json(payment);
  } catch (error) {
    if (error instanceof PaymentError) return NextResponse.json({ error: error.message }, { status: error.status });
    console.error("pagamento/criar", (error as Error).message);
    return NextResponse.json({ error: "Não foi possível iniciar o pagamento." }, { status: 500 });
  }
}
