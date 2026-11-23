"use client";

import { useEffect, useRef, useState } from "react";
import { DATA_CHANGED, useBusiness } from "./BusinessContext";

type Message = { role: "user" | "assistant"; content: string };

const SUGGESTIONS = [
  "Como está minha agenda de amanhã?",
  "Quantos horários vagos tenho quinta?",
  "Quem faltou este mês?",
  "Bloqueia minha agenda sábado à tarde",
];

/** Copiloto do dono: responde sobre a agenda e executa alterações. */
export function Copilot() {
  const { business } = useBusiness();
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [messages, busy, open]);

  async function send(text: string) {
    const content = text.trim();
    if (!content || busy) return;
    const history = [...messages, { role: "user" as const, content }];
    setMessages(history);
    setInput("");
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/copilot", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: history.slice(-30) }),
      });
      const body = await response.json();
      if (!response.ok) {
        setError(body.error ?? "O copiloto está indisponível no momento.");
      } else {
        setMessages([...history, { role: "assistant", content: body.reply }]);
        // Telas abertas (agenda, serviços, horários) recarregam para refletir a alteração.
        if (body.changed) window.dispatchEvent(new Event(DATA_CHANGED));
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
        className="fixed bottom-4 right-4 z-30 flex items-center gap-2 rounded-full bg-violet-700 px-4 py-3 text-sm font-semibold text-white shadow-lg hover:bg-violet-800 print:hidden"
      >
        <span aria-hidden>✨</span> Copiloto
      </button>
    );
  }

  return (
    <section
      aria-label="Copiloto"
      className="fixed inset-x-0 bottom-0 z-40 flex h-[80dvh] flex-col border border-stone-200 bg-white shadow-2xl sm:inset-x-auto sm:bottom-4 sm:right-4 sm:h-[600px] sm:w-[420px] sm:rounded-2xl print:hidden"
    >
      <header className="flex items-center justify-between bg-violet-700 px-4 py-3 text-white sm:rounded-t-2xl">
        <div>
          <p className="text-sm font-semibold">Copiloto de {business.name}</p>
          <p className="text-xs text-white/75">Pergunte sobre a agenda ou peça uma alteração</p>
        </div>
        <button onClick={() => setOpen(false)} aria-label="Fechar copiloto" className="rounded-lg p-1.5 hover:bg-white/10">
          ✕
        </button>
      </header>

      <div className="flex-1 space-y-3 overflow-y-auto px-4 py-4" aria-live="polite">
        {messages.length === 0 && (
          <div className="space-y-2">
            <p className="text-sm text-stone-600">
              Eu consulto sua agenda, horários vagos, faltas e clientes, e faço alterações como bloquear um período,
              pausar um serviço ou fechar a agenda online. Experimente:
            </p>
            {SUGGESTIONS.map((suggestion) => (
              <button key={suggestion} onClick={() => send(suggestion)}
                className="block w-full rounded-lg border border-stone-200 px-3 py-2 text-left text-sm text-stone-700 hover:border-violet-400">
                {suggestion}
              </button>
            ))}
          </div>
        )}
        {messages.map((message, index) => (
          <div key={index} className={`flex ${message.role === "user" ? "justify-end" : "justify-start"}`}>
            <div
              data-role={message.role}
              className={`max-w-[88%] whitespace-pre-wrap break-words rounded-2xl px-3.5 py-2.5 text-sm ${
                message.role === "user" ? "rounded-br-md bg-violet-700 text-white" : "rounded-bl-md bg-stone-100 text-stone-900"
              }`}
            >
              {message.content}
            </div>
          </div>
        ))}
        {busy && <p className="animate-pulse text-sm text-stone-500">Consultando a agenda...</p>}
        {error && <p role="alert" className="text-center text-xs text-red-700">{error}</p>}
        <div ref={endRef} />
      </div>

      <form
        onSubmit={(event) => {
          event.preventDefault();
          send(input);
        }}
        className="flex gap-2 border-t border-stone-200 p-3"
      >
        <input className="input" placeholder="Ex.: bloqueia sexta depois das 16h" aria-label="Mensagem para o copiloto"
          maxLength={2000} value={input} onChange={(e) => setInput(e.target.value)} />
        <button className="btn bg-violet-700 text-white hover:bg-violet-800" disabled={busy || !input.trim()}>
          Enviar
        </button>
      </form>
    </section>
  );
}
