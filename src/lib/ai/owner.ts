import { NextResponse } from "next/server";
import { fetchBusinessByOwner } from "../data";
import { createClient } from "../supabase/server";
import { aiConfigured } from "./client";

/** Autentica o dono para as rotas de IA do painel e aplica o teto de uso do estabelecimento. */
export async function requireOwner() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: NextResponse.json({ error: "Faça login." }, { status: 401 }) } as const;
  if (!aiConfigured()) {
    return {
      error: NextResponse.json({ error: "A IA ainda não foi configurada nesta instalação." }, { status: 503 }),
    } as const;
  }
  const business = await fetchBusinessByOwner(supabase, user.id);
  if (!business) {
    return { error: NextResponse.json({ error: "Crie seu estabelecimento primeiro." }, { status: 404 }) } as const;
  }
  const { data: allowed } = await supabase.rpc("ai_rate_hit", { p_business_id: business.id, p_client: `owner:${user.id}` });
  if (allowed === false) {
    return {
      error: NextResponse.json({ error: "Muitas solicitações à IA em pouco tempo. Aguarde alguns minutos." }, { status: 429 }),
    } as const;
  }
  return { supabase, business } as const;
}
