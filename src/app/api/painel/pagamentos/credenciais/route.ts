import { NextResponse } from "next/server";
import { z } from "zod";
import { fetchBusinessByOwner } from "@/lib/data";
import { accessHash, encryptCredential, paymentsConfigured, serverProof } from "@/lib/payments/crypto";
import { createClient } from "@/lib/supabase/server";

const Body = z.object({
  provider: z.literal("mercadopago"),
  // Access token de produção do estabelecimento. Nunca é devolvido nem escrito em log.
  credential: z.string().trim().min(20).max(500),
});

async function owner() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: NextResponse.json({ error: "Faça login." }, { status: 401 }) } as const;
  const business = await fetchBusinessByOwner(supabase, user.id);
  if (!business) return { error: NextResponse.json({ error: "Crie seu estabelecimento primeiro." }, { status: 404 }) } as const;
  return { supabase, business } as const;
}

// Recebe a credencial do dono, cifra no servidor e guarda só o texto cifrado.
export async function POST(request: Request) {
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Informe a credencial do provedor." }, { status: 400 });
  if (!paymentsConfigured()) {
    return NextResponse.json({ error: "A cobrança online ainda não foi habilitada nesta instalação." }, { status: 503 });
  }
  const session = await owner();
  if ("error" in session) return session.error;
  const { supabase, business } = session;
  const { provider, credential } = parsed.data;
  const { error } = await supabase.rpc("set_payment_credentials", {
    p_business_id: business.id,
    p_provider: provider,
    p_ciphertext: encryptCredential(business.id, credential),
    p_key_hint: credential.slice(-4),
    p_access_hash: accessHash(business.id),
    p_server_proof: serverProof(),
  });
  if (error) {
    return NextResponse.json(
      { error: error.code === "AG403" ? error.message : "Não foi possível guardar a credencial." },
      { status: error.code === "AG403" ? 503 : 500 },
    );
  }
  return NextResponse.json({ connected: true, provider, key_hint: credential.slice(-4) });
}

export async function DELETE() {
  const session = await owner();
  if ("error" in session) return session.error;
  const { error } = await session.supabase.rpc("delete_payment_credentials", { p_business_id: session.business.id });
  if (error) return NextResponse.json({ error: "Não foi possível remover a credencial." }, { status: 500 });
  return NextResponse.json({ connected: false });
}

// Diz à tela se a instalação tem a chave mestra (sem ela a cobrança não pode ser ligada).
export async function GET() {
  const session = await owner();
  if ("error" in session) return session.error;
  const { data } = await session.supabase.rpc("payment_credentials_status", { p_business_id: session.business.id });
  return NextResponse.json({ available: paymentsConfigured(), ...(data as object) });
}
