"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { maskPhone } from "@/components/booking/BookingFlow";
import { errorMessage, SEGMENTS, SLUG_PATTERN, slugify } from "@/lib/format";
import { createClient } from "@/lib/supabase/client";
import type { Segment } from "@/lib/types";

/** Primeira tela depois do cadastro: o dono escolhe o ramo e recebe serviços e regras típicas para ajustar. */
export function CreateBusinessForm() {
  const router = useRouter();
  const [segment, setSegment] = useState<Segment | null>(null);
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugEdited, setSlugEdited] = useState(false);
  const [phone, setPhone] = useState("");
  const [professional, setProfessional] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const chosen = SEGMENTS.find((item) => item.value === segment);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    if (!segment) return setError("Escolha o tipo do estabelecimento.");
    if (!SLUG_PATTERN.test(slug)) return setError("Escolha um endereço com 3 a 40 letras minúsculas, números ou hífen.");
    setBusy(true);
    const { error } = await createClient().rpc("create_business", {
      p: { name, slug, segment, phone, professional_name: professional },
    });
    if (error) {
      setError(errorMessage(error, "Não foi possível criar o estabelecimento."));
      setBusy(false);
      return;
    }
    router.refresh();
  }

  return (
    <main className="flex flex-1 items-center justify-center px-5 py-12">
      <form onSubmit={submit} className="w-full max-w-lg space-y-5">
        <div>
          <h1 className="text-2xl font-bold">Vamos criar a sua agenda</h1>
          <p className="mt-1 text-sm text-stone-600">
            Você recebe serviços, horários e regras típicas do seu ramo, e ajusta tudo depois.
          </p>
        </div>

        <fieldset>
          <legend className="label">Tipo do estabelecimento</legend>
          <div className="grid gap-2 sm:grid-cols-2">
            {SEGMENTS.map((item) => (
              <label
                key={item.value}
                className={`cursor-pointer rounded-xl border px-4 py-3 ${
                  segment === item.value ? "border-brand bg-brand/5 ring-2 ring-brand/20" : "border-stone-300 bg-white"
                }`}
              >
                <input type="radio" name="segment" value={item.value} className="sr-only"
                  checked={segment === item.value} onChange={() => setSegment(item.value)} />
                <span className="block font-semibold">{item.label}</span>
                <span className="block text-xs text-stone-500">{item.hint}</span>
              </label>
            ))}
          </div>
        </fieldset>

        <div>
          <label className="label" htmlFor="name">Nome do estabelecimento</label>
          <input id="name" required minLength={2} maxLength={80} className="input" placeholder="Ex.: Studio Bela"
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              if (!slugEdited) setSlug(slugify(e.target.value));
            }} />
        </div>
        <div>
          <label className="label" htmlFor="slug">Endereço da sua página</label>
          <div className="flex items-center gap-1">
            <span className="text-sm text-stone-500">seusite.com/</span>
            <input id="slug" required className="input" value={slug}
              onChange={(e) => {
                setSlugEdited(true);
                setSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ""));
              }} />
          </div>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label className="label" htmlFor="phone">WhatsApp (opcional)</label>
            <input id="phone" className="input" inputMode="tel" placeholder="(11) 99999-9999"
              value={phone} onChange={(e) => setPhone(maskPhone(e.target.value))} />
          </div>
          <div>
            <label className="label" htmlFor="professional">Primeiro profissional</label>
            <input id="professional" className="input" maxLength={60} placeholder={chosen?.professional ?? "Ex.: seu nome"}
              value={professional} onChange={(e) => setProfessional(e.target.value)} />
          </div>
        </div>
        <p className="text-xs text-stone-500">
          Você adiciona outros profissionais depois.
          {segment === "bronze" ? " Em studio de bronze, cadastre cada vaga ou cabine como um profissional." : ""}
        </p>
        {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
        <button className="btn-primary w-full py-3" disabled={busy}>
          {busy ? "Criando..." : "Criar minha agenda"}
        </button>
      </form>
    </main>
  );
}
