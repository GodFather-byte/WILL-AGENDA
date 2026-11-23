"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useState } from "react";
import { BRAND } from "@/lib/brand";
import { createClient } from "@/lib/supabase/client";
import { useConfirmationWatcher } from "@/lib/supabase/confirm";

const AUTH_ERRORS: Record<string, string> = {
  invalid_credentials: "E-mail ou senha incorretos.",
  user_already_exists: "Já existe uma conta com este e-mail.",
  weak_password: "Senha fraca. Use pelo menos 8 caracteres.",
  email_not_confirmed: "Confirme seu e-mail antes de entrar.",
  over_email_send_rate_limit: "Muitas tentativas. Aguarde um minuto.",
};

export function AuthForm({ mode }: { mode: "login" | "signup" }) {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const params = useSearchParams();
  const [notice, setNotice] = useState<string | null>(
    params.get("confirmado") ? "E-mail confirmado. Entre com sua senha para abrir o painel." : null,
  );
  const [error, setError] = useState<string | null>(
    params.get("link") ? "Este link de confirmação é inválido ou expirou. Tente entrar ou cadastre-se de novo." : null,
  );
  const [busy, setBusy] = useState(false);
  const signup = mode === "signup";
  // Cadastro feito e e-mail ainda não confirmado: a tela fica de olho e entra sozinha.
  const [waiting, setWaiting] = useState<{ email: string; password: string } | null>(null);
  const enter = useCallback(() => {
    router.push("/painel");
    router.refresh();
  }, [router]);
  useConfirmationWatcher(waiting, enter);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const supabase = createClient();
    const { data, error } = signup
      ? await supabase.auth.signUp({
          email,
          password,
          options: { emailRedirectTo: `${window.location.origin}/auth/callback` },
        })
      : await supabase.auth.signInWithPassword({ email, password });
    if (error) {
      setError(AUTH_ERRORS[error.code ?? ""] ?? "Não foi possível continuar. Tente novamente.");
      setBusy(false);
      return;
    }
    if (signup && !data.session) {
      setWaiting({ email, password });
      setNotice(
        "Enviamos um link de confirmação para o seu e-mail. Toque nele e volte para esta tela: " +
          "ela abre o painel sozinha assim que o e-mail for confirmado.",
      );
      setBusy(false);
      return;
    }
    enter();
  }

  return (
    <main className="flex flex-1 items-center justify-center px-5 py-12">
      <div className="w-full max-w-sm">
        <Link href="/" className="text-lg font-bold tracking-tight">
          {BRAND.name}
        </Link>
        <h1 className="mt-6 text-2xl font-bold">{signup ? "Crie sua conta" : "Entrar no painel"}</h1>
        <p className="mt-1 text-sm text-stone-600">
          {signup ? "Em seguida você configura o seu estabelecimento." : "Acompanhe a sua agenda em tempo real."}
        </p>

        <form onSubmit={submit} className="mt-6 space-y-4">
          <div>
            <label className="label" htmlFor="email">E-mail</label>
            <input id="email" type="email" required autoComplete="email" className="input"
              value={email} onChange={(e) => setEmail(e.target.value)} />
          </div>
          <div>
            <label className="label" htmlFor="password">Senha</label>
            <input id="password" type="password" required minLength={8} className="input"
              autoComplete={signup ? "new-password" : "current-password"}
              value={password} onChange={(e) => setPassword(e.target.value)} />
          </div>
          {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
          {notice && <p role="status" className="text-sm text-green-700">{notice}</p>}
          {waiting ? (
            <p role="status" className="flex items-center justify-center gap-2 rounded-lg bg-stone-100 px-3 py-3 text-sm text-stone-700">
              <span className="h-2 w-2 animate-pulse rounded-full bg-brand" />
              Aguardando a confirmação do e-mail...
            </p>
          ) : (
            <button className="btn-primary w-full" disabled={busy}>
              {busy ? "Aguarde..." : signup ? "Criar conta" : "Entrar"}
            </button>
          )}
        </form>

        <p className="mt-6 text-sm text-stone-600">
          {signup ? "Já tem conta? " : "Ainda não tem conta? "}
          <Link href={signup ? "/login" : "/cadastro"} className="font-semibold text-brand">
            {signup ? "Entrar" : "Criar minha agenda"}
          </Link>
        </p>
      </div>
    </main>
  );
}
