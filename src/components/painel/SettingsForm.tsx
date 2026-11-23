"use client";

import { useState } from "react";
import { maskPhone } from "@/components/booking/BookingFlow";
import { InstallPrompt } from "@/components/InstallGuide";
import { STORAGE_PREFIX } from "@/lib/brand";
import { formatPhone, normalizePhone, SEGMENT_LABEL, SLUG_PATTERN } from "@/lib/format";
import { createClient } from "@/lib/supabase/client";
import { useBusiness } from "./BusinessContext";
import { LogoUpload } from "./LogoUpload";

const NOTICE_OPTIONS = [
  [0, "Sem antecedência"], [30, "30 minutos"], [60, "1 hora"], [120, "2 horas"], [240, "4 horas"],
  [720, "12 horas"], [1440, "24 horas"], [2880, "2 dias"],
] as const;
const CANCEL_OPTIONS = [
  [0, "Até a hora marcada"], [60, "1 hora antes"], [120, "2 horas antes"], [240, "4 horas antes"],
  [720, "12 horas antes"], [1440, "24 horas antes"], [2880, "2 dias antes"],
] as const;

export function SettingsForm() {
  const { business, setBusiness } = useBusiness();
  const [form, setForm] = useState({
    name: business.name,
    slug: business.slug,
    description: business.description ?? "",
    booking_notice: business.booking_notice ?? "",
    phone: business.phone ? formatPhone(business.phone) : "",
    address: business.address ?? "",
    primary_color: business.primary_color,
    auto_confirm: business.auto_confirm,
    choose_professional: business.choose_professional,
    slot_step_minutes: business.slot_step_minutes,
    min_notice_minutes: business.min_notice_minutes,
    max_advance_days: String(business.max_advance_days),
    cancel_notice_minutes: business.cancel_notice_minutes,
  });
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const set = <K extends keyof typeof form>(key: K, value: (typeof form)[K]) => setForm((f) => ({ ...f, [key]: value }));

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setMessage(null);
    const phone = form.phone.trim() ? normalizePhone(form.phone) : null;
    const days = parseInt(form.max_advance_days);
    if (form.phone.trim() && !phone) return setMessage({ ok: false, text: "WhatsApp inválido. Informe com DDD." });
    if (!SLUG_PATTERN.test(form.slug)) return setMessage({ ok: false, text: "Endereço inválido: use 3 a 40 letras minúsculas, números ou hífen." });
    if (!(days >= 1 && days <= 365)) return setMessage({ ok: false, text: "A janela de agendamento deve ficar entre 1 e 365 dias." });
    setBusy(true);
    const patch = {
      name: form.name.trim(),
      slug: form.slug,
      description: form.description.trim() || null,
      booking_notice: form.booking_notice.trim() || null,
      phone,
      address: form.address.trim() || null,
      primary_color: form.primary_color,
      auto_confirm: form.auto_confirm,
      choose_professional: form.choose_professional,
      slot_step_minutes: form.slot_step_minutes,
      min_notice_minutes: form.min_notice_minutes,
      max_advance_days: days,
      cancel_notice_minutes: form.cancel_notice_minutes,
    };
    const { error } = await createClient().from("businesses").update(patch).eq("id", business.id);
    setBusy(false);
    if (error) {
      return setMessage({
        ok: false,
        text: error.code === "23505" ? "Este endereço já está em uso. Escolha outro."
          : error.code === "23514" ? "Este endereço é reservado ou inválido. Escolha outro." : "Não foi possível salvar.",
      });
    }
    setBusiness({ ...business, ...patch });
    setMessage({ ok: true, text: "Configurações salvas." });
  }

  return (
    <form onSubmit={save} className="max-w-2xl space-y-8">
      <h1 className="text-xl font-bold">Configurações</h1>

      <section className="card space-y-4 p-5">
        <h2 className="font-semibold">Sua marca</h2>
        <LogoUpload />
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-stone-50 px-3 py-2.5">
          <p className="min-w-0 flex-1 text-sm text-stone-700">Use o painel como aplicativo, com o seu logotipo na tela inicial.</p>
          <InstallPrompt variant="button" appName={business.name} storageKey={`${STORAGE_PREFIX}:instalar:painel`} className="py-2" />
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label className="label" htmlFor="s-name">Nome</label>
            <input id="s-name" required minLength={2} maxLength={80} className="input" value={form.name} onChange={(e) => set("name", e.target.value)} />
          </div>
          <div>
            <label className="label" htmlFor="s-color">Cor</label>
            <input id="s-color" type="color" className="h-[42px] w-full rounded-lg border border-stone-300 bg-white p-1"
              value={form.primary_color} onChange={(e) => set("primary_color", e.target.value)} />
          </div>
        </div>
        <div>
          <label className="label" htmlFor="s-slug">Endereço da página</label>
          <div className="flex items-center gap-1">
            <span className="text-sm text-stone-500">/</span>
            <input id="s-slug" required className="input" value={form.slug}
              onChange={(e) => set("slug", e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ""))} />
          </div>
          {form.slug !== business.slug && (
            <p className="mt-1 text-xs text-amber-700">
              Ao trocar o endereço, links já enviados a clientes (inclusive os de agendamentos) deixam de funcionar.
            </p>
          )}
        </div>
        <div>
          <label className="label" htmlFor="s-desc">Descrição curta</label>
          <textarea id="s-desc" rows={2} maxLength={300} className="input" value={form.description} onChange={(e) => set("description", e.target.value)} />
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label className="label" htmlFor="s-phone">WhatsApp</label>
            <input id="s-phone" inputMode="tel" className="input" placeholder="(11) 99999-9999" value={form.phone}
              onChange={(e) => set("phone", maskPhone(e.target.value))} />
          </div>
          <div>
            <label className="label" htmlFor="s-address">Endereço</label>
            <input id="s-address" maxLength={200} className="input" value={form.address} onChange={(e) => set("address", e.target.value)} />
          </div>
        </div>
        <div>
          <label className="label" htmlFor="s-notice">Recado para quem agenda</label>
          <textarea id="s-notice" rows={2} maxLength={500} className="input" placeholder="Ex.: Chegue 10 minutos antes. Estacionamento no local."
            value={form.booking_notice} onChange={(e) => set("booking_notice", e.target.value)} />
        </div>
        <p className="text-xs text-stone-500">Tipo do estabelecimento: {SEGMENT_LABEL[business.segment]}.</p>
      </section>

      <section className="card space-y-4 p-5">
        <h2 className="font-semibold">Regras de agendamento</h2>
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" className="mt-0.5" checked={form.auto_confirm} onChange={(e) => set("auto_confirm", e.target.checked)} />
          <span>
            Confirmar automaticamente os agendamentos feitos pelo cliente
            <span className="block text-xs text-stone-500">Desmarcado, cada agendamento entra como “aguardando confirmação” até você confirmar. O horário fica reservado nos dois casos.</span>
          </span>
        </label>
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" className="mt-0.5" checked={form.choose_professional} onChange={(e) => set("choose_professional", e.target.checked)} />
          <span>
            Cliente escolhe o profissional
            <span className="block text-xs text-stone-500">Desmarcado, o sistema escolhe quem estiver livre.</span>
          </span>
        </label>
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label className="label" htmlFor="s-step">Horários oferecidos a cada</label>
            <select id="s-step" className="input" value={form.slot_step_minutes} onChange={(e) => set("slot_step_minutes", Number(e.target.value))}>
              {[5, 10, 15, 20, 30, 60].map((m) => <option key={m} value={m}>{m} minutos</option>)}
            </select>
          </div>
          <div>
            <label className="label" htmlFor="s-min">Antecedência mínima para agendar</label>
            <select id="s-min" className="input" value={form.min_notice_minutes} onChange={(e) => set("min_notice_minutes", Number(e.target.value))}>
              {withCurrent(NOTICE_OPTIONS, form.min_notice_minutes).map(([m, label]) => <option key={m} value={m}>{label}</option>)}
            </select>
          </div>
          <div>
            <label className="label" htmlFor="s-max">Agenda aberta para os próximos (dias)</label>
            <input id="s-max" inputMode="numeric" className="input" value={form.max_advance_days} onChange={(e) => set("max_advance_days", e.target.value)} />
          </div>
          <div>
            <label className="label" htmlFor="s-cancel">Cliente cancela ou remarca</label>
            <select id="s-cancel" className="input" value={form.cancel_notice_minutes} onChange={(e) => set("cancel_notice_minutes", Number(e.target.value))}>
              {withCurrent(CANCEL_OPTIONS, form.cancel_notice_minutes).map(([m, label]) => <option key={m} value={m}>{label}</option>)}
            </select>
          </div>
        </div>
      </section>

      {message && (
        <p role={message.ok ? "status" : "alert"} className={`text-sm ${message.ok ? "text-green-700" : "text-red-700"}`}>
          {message.text}
        </p>
      )}
      <button className="btn-primary" disabled={busy}>{busy ? "Salvando..." : "Salvar configurações"}</button>
    </form>
  );
}

/** Inclui o valor atual na lista, caso ele tenha sido definido fora das opções (pelo copiloto, por exemplo). */
function withCurrent(options: readonly (readonly [number, string])[], current: number) {
  return options.some(([m]) => m === current) ? options : [...options, [current, `${current} minutos`] as const];
}
