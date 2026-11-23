import type { EmailOtpType } from "@supabase/supabase-js";
import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";

// Destino do link de confirmação de e-mail: abre a sessão e leva o dono ao painel.
// O destino é fixo: nunca redireciona para um endereço vindo da URL.
export async function GET(request: NextRequest) {
  const { searchParams, origin } = request.nextUrl;
  const code = searchParams.get("code");
  const tokenHash = searchParams.get("token_hash");
  const type = searchParams.get("type") as EmailOtpType | null;

  const supabase = await createClient();
  if (code) {
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) return NextResponse.redirect(`${origin}/painel`);
  } else if (tokenHash && type) {
    const { error } = await supabase.auth.verifyOtp({ token_hash: tokenHash, type });
    if (!error) return NextResponse.redirect(`${origin}/painel`);
  }

  // Link aberto em outro aparelho ou navegador: o e-mail já foi confirmado,
  // mas a sessão só pode ser aberta com a senha.
  const failed = searchParams.has("error") || (!code && !tokenHash);
  return NextResponse.redirect(`${origin}/login?${failed ? "link=invalido" : "confirmado=1"}`);
}
