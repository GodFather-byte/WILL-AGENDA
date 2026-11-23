import { NextResponse } from "next/server";
import { isProvider } from "@/lib/payments/providers";
import { handleNotification } from "@/lib/payments/service";
import { createPublicClient } from "@/lib/supabase/public";

export const maxDuration = 30;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Aviso do provedor de pagamento. Qualquer um pode chamar este endereço, então o corpo não vale
// como prova de nada: dele só sai o identificador da cobrança, e a situação é buscada na API do
// provedor com a credencial do estabelecimento. Repetições são inofensivas.
export async function POST(request: Request, { params }: RouteContext<"/api/webhooks/pagamento/[provider]">) {
  const { provider } = await params;
  const url = new URL(request.url);
  const businessId = url.searchParams.get("b") ?? "";
  if (!isProvider(provider) || !UUID.test(businessId)) return NextResponse.json({ ok: true });

  const body = (await request.json().catch(() => null)) as { type?: string; topic?: string; data?: { id?: unknown } } | null;
  const type = body?.type ?? body?.topic ?? url.searchParams.get("type") ?? url.searchParams.get("topic");
  const id = body?.data?.id ?? url.searchParams.get("data.id") ?? url.searchParams.get("id");
  if (type !== "payment" || id === null || id === undefined || !/^[\w-]{1,64}$/.test(String(id))) {
    return NextResponse.json({ ok: true });
  }

  try {
    await handleNotification(createPublicClient(), businessId, provider, String(id));
    return NextResponse.json({ ok: true });
  } catch (error) {
    // Falha nossa ou do provedor: responde erro para o provedor avisar de novo mais tarde.
    console.error("webhook de pagamento", provider, (error as Error).message);
    return NextResponse.json({ ok: false }, { status: 500 });
  }
}
