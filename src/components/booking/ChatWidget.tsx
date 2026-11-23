"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import type { Business } from "@/lib/types";
import { forgetAppointment, loadAppointments, saveAppointment } from "./storage";

type Message = { role: "user" | "assistant"; content: string; appointmentToken?: string };
type ChangedAppointment = { token: string; date: string; time: string; service: string; status: string };

/** Atendente de IA da página pública: tira dúvidas, oferece horários e agenda, remarca e cancela pelo chat. */
export function ChatWidget({ business }: { business: Pick<Business, "slug" | "name"> }) {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [messages, busy, open]);

  async function send(event: React.FormEvent) {
    event.preventDefault();
    const content = input.trim();
    if (!content || busy) return;
    const history = [...messages, { role: "user" as const, content }];
    setMessages(history);
    setInput("");
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          slug: business.slug,
          messages: history.slice(-30).map(({ role, content }) => ({ role, content })),
          tokens: loadAppointments(business.slug).map((item) => item.token).slice(0, 5),
        }),
      });
      const body = await response.json();
      if (!response.ok) {
        setError(body.error ?? "O atendente está indisponível no momento.");
      } else {
        const changed = (body.appointments ?? []) as ChangedAppointment[];
        for (const item of changed) {
          if (item.status === "canceled") forgetAppointment(business.slug, item.token);
          else saveAppointment(business.slug, { token: item.token, date: item.date, time: item.time, service: item.service });
        }
        const shown = changed.find((item) => item.status !== "canceled");
        setMessages([...history, { role: "assistant", content: body.reply, appointmentToken: shown?.token }]);
      }
    } catch {
      setError("Falha de conexão. Tente novamente.");
    }
    setBusy(false);
  }

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="fixed bottom-4 right-4 z-30 flex items-center gap-2 rounded-full bg-stone-900 px-4 py-3 text-sm font-semibold text-white shadow-lg"
      >
        <span aria-hidden>💬</span> Agendar pelo chat
      </button>
    );
  }

  return (
    <section
      aria-label="Atendente virtual"
      className="fixed inset-x-0 bottom-0 z-40 flex h-[80dvh] flex-col border border-stone-200 bg-white shadow-2xl sm:inset-x-auto sm:bottom-4 sm:right-4 sm:h-[560px] sm:w-96 sm:rounded-2xl"
    >
      <header className="flex items-center justify-between bg-stone-900 px-4 py-3 text-white sm:rounded-t-2xl">
        <div>
          <p className="text-sm font-semibold">Atendente de {business.name}</p>
          <p className="text-xs text-white/70">Assistente de IA · responde na hora</p>
        </div>
        <button onClick={() => setOpen(false)} aria-label="Fechar chat" className="rounded-lg p-1.5 hover:bg-white/10">✕</button>
      </header>

      <div className="flex-1 space-y-3 overflow-y-auto px-4 py-4" aria-live="polite">
        <Bubble role="greeting">
          Oi! Sou o atendente virtual de {business.name}. Posso tirar dúvidas, ver horários livres e agendar, remarcar ou
          cancelar para você. Não escreva informações de saúde aqui.
        </Bubble>
        {messages.map((message, index) => (
          <Bubble key={index} role={message.role}>
            {message.content}
            {message.appointmentToken && (
              <Link href={`/${business.slug}/agendamento/${message.appointmentToken}`}
                className="mt-2 block rounded-lg bg-brand px-3 py-2 text-center font-semibold text-brand-fg">
                Ver meu agendamento
              </Link>
            )}
          </Bubble>
        ))}
        {busy && <Bubble role="greeting"><span className="animate-pulse">Digitando...</span></Bubble>}
        {error && <p role="alert" className="text-center text-xs text-red-700">{error}</p>}
        <div ref={endRef} />
      </div>

      <form onSubmit={send} className="flex gap-2 border-t border-stone-200 p-3">
        <input className="input" placeholder="Escreva sua mensagem..." aria-label="Mensagem" maxLength={1000}
          value={input} onChange={(e) => setInput(e.target.value)} />
        <button className="btn-primary" disabled={busy || !input.trim()}>Enviar</button>
      </form>
    </section>
  );
}

function Bubble({ role, children }: { role: "user" | "assistant" | "greeting"; children: React.ReactNode }) {
  return (
    <div className={`flex ${role === "user" ? "justify-end" : "justify-start"}`}>
      <div
        data-role={role}
        className={`max-w-[85%] whitespace-pre-wrap break-words rounded-2xl px-3.5 py-2.5 text-sm ${
          role === "user" ? "rounded-br-md bg-brand text-brand-fg" : "rounded-bl-md bg-stone-100 text-stone-900"
        }`}
      >
        {children}
      </div>
    </div>
  );
}
