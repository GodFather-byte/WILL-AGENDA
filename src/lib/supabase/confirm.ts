"use client";

import { useEffect, useRef } from "react";
import { createClient } from "./client";

/**
 * Depois do cadastro, enquanto a pessoa confirma o e-mail: tenta entrar sozinho quando ela volta para esta tela
 * (e de tempos em tempos). Assim, tanto faz onde o link do e-mail abriu — outro navegador, o app de e-mail ou
 * outro aparelho —, a conta abre aqui mesmo, no app instalado, sem precisar digitar a senha de novo.
 *
 * O intervalo é folgado de propósito: o Supabase limita tentativas de login por minuto.
 */
export function useConfirmationWatcher(
  waiting: { email: string; password: string } | null,
  onSignedIn: () => void,
) {
  const done = useRef(onSignedIn);
  useEffect(() => {
    done.current = onSignedIn;
  }, [onSignedIn]);

  useEffect(() => {
    if (!waiting) return;
    let stopped = false;
    let busy = false;
    let last = 0;

    async function attempt() {
      if (stopped || busy || document.visibilityState !== "visible" || Date.now() - last < 8000) return;
      busy = true;
      last = Date.now();
      const { data } = await createClient().auth.signInWithPassword(waiting!);
      busy = false;
      if (data.session && !stopped) {
        stopped = true;
        done.current();
      }
    }

    const interval = setInterval(attempt, 20000);
    document.addEventListener("visibilitychange", attempt);
    window.addEventListener("focus", attempt);
    return () => {
      stopped = true;
      clearInterval(interval);
      document.removeEventListener("visibilitychange", attempt);
      window.removeEventListener("focus", attempt);
    };
  }, [waiting]);
}
