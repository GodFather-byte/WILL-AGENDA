import { NextResponse } from "next/server";
import { fetchBusinessByOwner } from "@/lib/data";
import { processRefunds } from "@/lib/payments/service";
import { createPublicClient } from "@/lib/supabase/public";
import { createClient } from "@/lib/supabase/server";

export const maxDuration = 60;

// O painel chama ao abrir a agenda e depois de cancelar: faz os estornos pendentes do estabelecimento.
export async function POST() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Faça login." }, { status: 401 });
  const business = await fetchBusinessByOwner(supabase, user.id);
  if (!business) return NextResponse.json({ refunded: 0, failed: 0 });
  try {
    return NextResponse.json(await processRefunds(createPublicClient(), business.id));
  } catch (error) {
    console.error("pagamentos/pendencias", (error as Error).message);
    return NextResponse.json({ refunded: 0, failed: 0 });
  }
}
