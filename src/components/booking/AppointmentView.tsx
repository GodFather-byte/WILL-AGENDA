"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { brandStyle } from "@/lib/color";
import { dateTimeInSaoPaulo, friendlyDate } from "@/lib/dates";
import { durationLabel, errorMessage, noticeLabel, priceLabel, STATUS_LABEL, whatsappLink } from "@/lib/format";
import { createClient } from "@/lib/supabase/client";
import type { AppointmentStatus, PublicAppointment, Slot } from "@/lib/types";
import { BusinessHeader } from "./BusinessHeader";
import { PaymentPanel, syncPayment } from "./PaymentPanel";
import { SlotPicker } from "./SlotPicker";
import { forgetAppointment, saveAppointment } from "./storage";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const STATUS_STYLE: Record<AppointmentStatus, string> = {
  pending: "bg-amber-100 text-amber-900",
  confirmed: "bg-green-100 text-green-800",
  completed: "bg-stone-200 text-stone-700",
  no_show: "bg-red-100 text-red-800",
  canceled: "bg-red-100 text-red-800",
};

/** Página do agendamento pelo link secreto: ver, remarcar e cancelar dentro da regra do estabelecimento. */
export function AppointmentView({ slug, token, today }: { slug: string; token: string; today: string }) {
  const supabase = useMemo(() => createClient(), []);
  const [appointment, setAppointment] = useState<PublicAppointment | null | undefined>(undefined);
  const [offline, setOffline] = useState(false);
  const [mode, setMode] = useState<"view" | "reschedule" | "cancel">("view");
  const [slot, setSlot] = useState<{ slot: Slot; date: string } | null>(null);
  const [anyProfessional, setAnyProfessional] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  const load = useCallback(async () => {
    if (!UUID.test(token)) return setAppointment(null);
    const { data, error } = await supabase.rpc("get_appointment", { p_token: token });
    if (error) return setOffline(true);
    setOffline(false);
    const next = (data as PublicAppointment | null) ?? null;
    setAppointment(next);
    if (next) {
      // Mantém o atalho deste aparelho em dia (ou esquece, se o agendamento foi encerrado).
      if (["pending", "confirmed"].includes(next.status) && !next.is_past) {
        saveAppointment(next.business.slug, { token, date: next.date, time: next.time, service: next.service_name });
      } else {
        forgetAppointment(next.business.slug, token);
      }
    }
  }, [supabase, token]);

  const open = appointment ? ["pending", "confirmed"].includes(appointment.status) && !appointment.is_past : false;

  useEffect(() => {
    const first = setTimeout(load, 0);
    // Enquanto o agendamento está em aberto, acompanha mudanças feitas pelo estabelecimento.
    const interval = open && mode === "view" ? setInterval(load, 15000) : undefined;
    return () => {
      clearTimeout(first);
      clearInterval(interval);
    };
  }, [load, open, mode]);

  if (appointment === undefined) {
    return (
      <main className="flex flex-1 items-center justify-center px-5 text-sm text-stone-500">
        {offline ? "Sem conexão. Tentando de novo..." : "Carregando agendamento..."}
      </main>
    );
  }
  if (appointment === null) {
    return (
      <main className="flex flex-1 flex-col items-center justify-center gap-3 px-5 text-center">
        <p className="font-semibold">Agendamento não encontrado.</p>
        <p className="max-w-sm text-sm text-stone-600">Confira se o link está completo. Se preferir, faça um novo agendamento.</p>
        <Link href={`/${slug}`} className="btn-outline">Ir para a página de agendamento</Link>
      </main>
    );
  }

  const { business } = appointment;
  const deadline = noticeLabel(business.cancel_notice_minutes);
  // Mantém o profissional, a menos que o cliente aceite outro ou que o estabelecimento não deixe escolher.
  const keepProfessional = business.choose_professional && !anyProfessional;

  async function reschedule() {
    if (!slot || !appointment) return;
    setBusy(true);
    setError(null);
    const { data, error } = await supabase.rpc("reschedule_appointment", {
      p_token: token,
      p_starts_at: slot.slot.at,
      p_professional_id: keepProfessional ? appointment.professional_id : null,
    });
    setBusy(false);
    if (error) {
      setError(errorMessage(error, "Não foi possível remarcar agora. Tente de novo em instantes."));
      if (error.code === "AG409") {
        setSlot(null);
        setRefreshKey((key) => key + 1);
      }
      return;
    }
    setAppointment(data as PublicAppointment);
    setSlot(null);
    setMode("view");
    setNotice("Agendamento remarcado.");
  }

  async function cancel(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const { error } = await supabase.rpc("cancel_appointment", { p_token: token, p_reason: reason });
    setBusy(false);
    if (error) return setError(errorMessage(error, "Não foi possível cancelar agora. Tente de novo em instantes."));
    setMode("view");
    setNotice(null);
    // Se havia sinal pago, o servidor faz o estorno agora.
    await syncPayment(token);
    await load();
  }

  return (
    <div style={brandStyle(business.primary_color)} className="flex flex-1 flex-col">
      <BusinessHeader business={business} />

      <main className="mx-auto w-full max-w-2xl flex-1 space-y-4 px-4 pb-16 pt-4">
        <section className="card p-5" aria-live="polite">
          <p className={`chip ${STATUS_STYLE[appointment.status]}`}>
            {appointment.payment_status === "awaiting" && appointment.status === "pending"
              ? "Aguardando pagamento"
              : appointment.status === "confirmed" && appointment.is_past
                ? "Realizado"
                : STATUS_LABEL[appointment.status]}
          </p>
          <h1 className="mt-3 text-xl font-bold">
            {appointment.service_name}
            <span className="block text-base font-semibold text-stone-700">
              {friendlyDate(appointment.date, today)} às {appointment.time}
            </span>
          </h1>
          {notice && <p role="status" className="mt-2 text-sm font-medium text-green-700">{notice}</p>}
          {appointment.status === "pending" && appointment.payment_status !== "awaiting" && (
            <p className="mt-2 text-sm text-stone-600">
              Seu horário está reservado. {business.name} ainda vai confirmar; esta página se atualiza sozinha.
            </p>
          )}
          {appointment.status === "canceled" && (
            <p className="mt-2 text-sm text-stone-600">
              Cancelado {appointment.canceled_by === "customer" ? "por você" : `por ${business.name}`}
              {appointment.cancel_reason ? `. Motivo: ${appointment.cancel_reason}` : "."}
            </p>
          )}
          {appointment.status === "no_show" && (
            <p className="mt-2 text-sm text-stone-600">Este horário ficou registrado como falta.</p>
          )}

          <dl className="mt-4 space-y-2 rounded-xl bg-stone-50 px-4 py-3 text-sm">
            <Row label="Com">{appointment.professional_name}</Row>
            <Row label="Duração">{durationLabel(appointment.duration_minutes)}</Row>
            <Row label="Valor">{priceLabel({ price_cents: appointment.price_cents, price_from: false })}</Row>
            {business.address && <Row label="Onde">{business.address}</Row>}
            <Row label="Em nome de">{appointment.customer_name}</Row>
            {appointment.notes && <Row label="Observação">{appointment.notes}</Row>}
          </dl>

          {open && business.booking_notice && (
            <p className="mt-4 whitespace-pre-line rounded-xl border border-stone-200 px-4 py-3 text-sm text-stone-700">
              {business.booking_notice}
            </p>
          )}
          {offline && <p className="mt-3 text-xs text-amber-700">Sem conexão. Mostrando a última atualização.</p>}
        </section>

        {mode === "view" && <PaymentPanel appointment={appointment} token={token} onChanged={load} />}

        {open && mode === "view" && (
          <section className="card space-y-3 p-5">
            {appointment.can_change ? (
              <>
                <div className="flex flex-col gap-2 sm:flex-row">
                  <button type="button" className="btn-primary flex-1" onClick={() => { setError(null); setNotice(null); setMode("reschedule"); }}>
                    Remarcar
                  </button>
                  <button type="button" className="btn-danger flex-1" onClick={() => { setError(null); setNotice(null); setMode("cancel"); }}>
                    Cancelar agendamento
                  </button>
                </div>
                {business.cancel_notice_minutes > 0 && (
                  <p className="text-xs text-stone-500">
                    Você pode remarcar ou cancelar por aqui até {dateTimeInSaoPaulo(appointment.change_deadline)} ({deadline} antes do horário).
                  </p>
                )}
              </>
            ) : (
              <p className="text-sm text-stone-700">
                Faltam menos de {deadline} para o seu horário, então não dá mais para remarcar ou cancelar pelo site.
                {business.phone ? " Fale direto com o estabelecimento:" : " Fale direto com o estabelecimento."}
              </p>
            )}
          </section>
        )}

        {open && mode === "reschedule" && appointment.service_id && (
          <section className="card space-y-4 p-5" aria-labelledby="reschedule-title">
            <h2 id="reschedule-title" className="text-lg font-bold">Escolha o novo horário</h2>
            {business.choose_professional && (
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={anyProfessional}
                  onChange={(e) => { setAnyProfessional(e.target.checked); setSlot(null); }} />
                Pode ser com outro profissional (mostra mais horários)
              </label>
            )}
            <SlotPicker
              businessId={business.id}
              serviceId={appointment.service_id}
              professionalId={keepProfessional ? appointment.professional_id : null}
              token={token}
              refreshKey={refreshKey}
              selected={slot?.slot ?? null}
              onSelect={(chosen, date) => { setError(null); setSlot({ slot: chosen, date }); }}
            />
            {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
            <div className="flex flex-col gap-2 sm:flex-row-reverse">
              <button type="button" className="btn-primary flex-1" disabled={!slot || busy} onClick={reschedule}>
                {busy
                  ? "Remarcando..."
                  : slot
                    ? `Remarcar para ${friendlyDate(slot.date, today)} às ${slot.slot.time}`
                    : "Escolha um horário"}
              </button>
              <button type="button" className="btn-ghost" disabled={busy} onClick={() => { setSlot(null); setMode("view"); }}>
                Voltar
              </button>
            </div>
          </section>
        )}
        {open && mode === "reschedule" && !appointment.service_id && (
          <section className="card p-5 text-sm text-stone-700">
            Este serviço não está mais disponível para remarcar pelo site. Fale direto com o estabelecimento.
            <button type="button" className="btn-ghost mt-3" onClick={() => setMode("view")}>Voltar</button>
          </section>
        )}

        {open && mode === "cancel" && (
          <form onSubmit={cancel} className="card space-y-4 p-5" aria-labelledby="cancel-title">
            <h2 id="cancel-title" className="text-lg font-bold">Cancelar este agendamento?</h2>
            <p className="text-sm text-stone-600">O horário volta a ficar livre para outras pessoas.</p>
            <div>
              <label className="label" htmlFor="cancel-reason">Motivo (opcional)</label>
              <input id="cancel-reason" className="input" maxLength={200} value={reason}
                onChange={(e) => setReason(e.target.value)} />
              <p className="mt-1 text-xs text-stone-500">Não escreva informações de saúde aqui.</p>
            </div>
            {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
            <div className="flex flex-col gap-2 sm:flex-row-reverse">
              <button className="btn-danger flex-1" disabled={busy}>{busy ? "Cancelando..." : "Sim, cancelar"}</button>
              <button type="button" className="btn-ghost" disabled={busy} onClick={() => setMode("view")}>Manter agendamento</button>
            </div>
          </form>
        )}

        <div className="flex flex-col gap-2 sm:flex-row">
          {business.phone && (
            <a className="btn-outline flex-1" target="_blank" rel="noreferrer"
              href={whatsappLink(business.phone, `Olá! Sobre o meu agendamento de ${appointment.service_name}, ${friendlyDate(appointment.date, today)} às ${appointment.time}.`)}>
              Falar com {business.name}
            </a>
          )}
          <Link href={`/${business.slug}`} className="btn-outline flex-1">
            {open ? "Agendar outro horário" : "Agendar de novo"}
          </Link>
        </div>
      </main>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-4">
      <dt className="shrink-0 text-stone-500">{label}</dt>
      <dd className="text-right font-medium">{children}</dd>
    </div>
  );
}
