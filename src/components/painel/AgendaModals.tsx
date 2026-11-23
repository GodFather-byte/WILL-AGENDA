"use client";

import { useEffect, useMemo, useState } from "react";
import { maskPhone } from "@/components/booking/BookingFlow";
import { Modal } from "@/components/Modal";
import { dateTimeInSaoPaulo, friendlyDate } from "@/lib/dates";
import {
  brl,
  durationLabel,
  errorMessage,
  formatPhone,
  PAYMENT_STATUS_LABEL,
  SOURCE_LABEL,
  STATUS_LABEL,
  whatsappLink,
} from "@/lib/format";
import { createClient } from "@/lib/supabase/client";
import type { OwnerAppointment, OwnerSlot } from "@/lib/types";
import { useBusiness } from "./BusinessContext";

/** Horário escolhido pelo dono: um da lista de livres, ou um encaixe digitado. */
type Choice = { starts_at: string; label: string } | { time: string; force: true } | null;

/**
 * Lista os horários livres do dia para o serviço e o profissional. "Encaixe" permite digitar
 * outro horário (fora do expediente ou em cima de bloqueio); o banco ainda impede sobreposição.
 */
function OwnerSlotChooser({
  serviceId,
  professionalId,
  date,
  ignoreAppointment,
  initialTime,
  onChange,
}: {
  serviceId: string;
  professionalId: string;
  date: string;
  ignoreAppointment?: string;
  initialTime?: string;
  onChange: (choice: Choice) => void;
}) {
  const { business } = useBusiness();
  const supabase = useMemo(() => createClient(), []);
  const [slots, setSlots] = useState<OwnerSlot[] | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const [custom, setCustom] = useState(false);
  const [time, setTime] = useState(initialTime ?? "");

  useEffect(() => {
    let active = true;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSlots(null);
    setPicked(null);
    supabase
      .rpc("owner_availability", {
        p_business_id: business.id,
        p_service_id: serviceId,
        p_professional_id: professionalId,
        p_date: date,
        p_ignore_appointment: ignoreAppointment ?? null,
      })
      .then(({ data }) => {
        if (!active) return;
        const list = (data ?? []) as OwnerSlot[];
        setSlots(list);
        // Veio de um clique na grade: já marca aquele horário, se estiver livre; senão, vira encaixe.
        const match = initialTime ? list.find((s) => s.time === initialTime) : undefined;
        if (match) {
          setPicked(match.at);
          setCustom(false);
          onChange({ starts_at: match.at, label: match.time });
        } else if (initialTime) {
          setCustom(true);
          onChange({ time: initialTime, force: true });
        } else {
          onChange(null);
        }
      });
    return () => {
      active = false;
    };
    // onChange e initialTime não mudam o que deve ser buscado.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [supabase, business.id, serviceId, professionalId, date, ignoreAppointment]);

  return (
    <div className="space-y-2">
      {!custom &&
        (slots === null ? (
          <p className="text-sm text-stone-500">Buscando horários livres...</p>
        ) : slots.length === 0 ? (
          <p className="text-sm text-stone-600">Nenhum horário livre neste dia para este profissional.</p>
        ) : (
          <div className="grid max-h-44 grid-cols-4 gap-2 overflow-y-auto sm:grid-cols-6" role="group" aria-label="Horários livres">
            {slots.map((slot) => (
              <button key={slot.at} type="button" aria-pressed={picked === slot.at}
                onClick={() => {
                  setPicked(slot.at);
                  onChange({ starts_at: slot.at, label: slot.time });
                }}
                className={`rounded-lg border px-2 py-2 text-sm font-semibold ${
                  picked === slot.at ? "border-brand bg-brand text-brand-fg" : "border-stone-300 bg-white hover:border-brand"
                }`}>
                {slot.time}
              </button>
            ))}
          </div>
        ))}
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={custom}
          onChange={(e) => {
            setCustom(e.target.checked);
            setPicked(null);
            onChange(e.target.checked && time ? { time, force: true } : null);
          }} />
        Encaixe: outro horário, mesmo fora do expediente
      </label>
      {custom && (
        <input type="time" aria-label="Horário do encaixe" className="input w-auto" value={time}
          onChange={(e) => {
            setTime(e.target.value);
            onChange(e.target.value ? { time: e.target.value, force: true } : null);
          }} />
      )}
    </div>
  );
}

const choicePayload = (choice: NonNullable<Choice>, date: string) =>
  "starts_at" in choice ? { starts_at: choice.starts_at } : { date, time: choice.time, force: true };

export function NewAppointmentModal({
  date: initialDate,
  professionalId: initialProfessional,
  time,
  customer,
  onClose,
  onCreated,
}: {
  date: string;
  professionalId?: string;
  time?: string;
  customer?: { name: string; phone: string };
  onClose: () => void;
  onCreated: () => void;
}) {
  const { business, catalog } = useBusiness();
  const services = catalog.services.filter((s) => s.is_active);
  const [serviceId, setServiceId] = useState(() => {
    const able = services.filter((s) => !initialProfessional || catalog.professionals.find((p) => p.id === initialProfessional)?.service_ids.includes(s.id));
    return (able[0] ?? services[0])?.id ?? "";
  });
  const able = catalog.professionals.filter((p) => p.is_active && p.service_ids.includes(serviceId));
  const [professionalId, setProfessionalId] = useState(initialProfessional ?? "");
  const effectiveProfessional = able.some((p) => p.id === professionalId) ? professionalId : (able[0]?.id ?? "");
  const [date, setDate] = useState(initialDate);
  const [choice, setChoice] = useState<Choice>(null);
  const [name, setName] = useState(customer?.name ?? "");
  const [phone, setPhone] = useState(customer ? formatPhone(customer.phone) : "");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!choice) return setError("Escolha o horário.");
    setBusy(true);
    setError(null);
    const { error } = await createClient().rpc("owner_create_appointment", {
      p: {
        business_id: business.id,
        service_id: serviceId,
        professional_id: effectiveProfessional,
        customer_name: name,
        customer_phone: phone,
        notes,
        ...choicePayload(choice, date),
      },
    });
    setBusy(false);
    if (error) return setError(errorMessage(error, "Não foi possível agendar."));
    onCreated();
    onClose();
  }

  return (
    <Modal title="Novo agendamento" onClose={onClose}>
      {services.length === 0 ? (
        <p className="text-sm text-stone-600">Cadastre um serviço ativo antes de agendar.</p>
      ) : (
        <form onSubmit={submit} className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label className="label" htmlFor="na-service">Serviço</label>
              <select id="na-service" className="input" value={serviceId} onChange={(e) => setServiceId(e.target.value)}>
                {services.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name} ({durationLabel(s.duration_minutes)})
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="label" htmlFor="na-professional">Profissional</label>
              <select id="na-professional" className="input" value={effectiveProfessional}
                onChange={(e) => setProfessionalId(e.target.value)}>
                {able.length === 0 && <option value="">Ninguém faz este serviço</option>}
                {able.map((p) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
            </div>
          </div>
          <div>
            <label className="label" htmlFor="na-date">Dia</label>
            <input id="na-date" type="date" required className="input w-auto" value={date}
              onChange={(e) => e.target.value && setDate(e.target.value)} />
          </div>
          {serviceId && effectiveProfessional && (
            <OwnerSlotChooser serviceId={serviceId} professionalId={effectiveProfessional} date={date}
              initialTime={time} onChange={setChoice} />
          )}
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label className="label" htmlFor="na-name">Nome do cliente</label>
              <input id="na-name" required minLength={2} maxLength={80} className="input" value={name}
                onChange={(e) => setName(e.target.value)} />
            </div>
            <div>
              <label className="label" htmlFor="na-phone">WhatsApp do cliente</label>
              <input id="na-phone" required inputMode="tel" className="input" placeholder="(11) 99999-9999" value={phone}
                onChange={(e) => setPhone(maskPhone(e.target.value))} />
            </div>
          </div>
          <div>
            <label className="label" htmlFor="na-notes">Observação (opcional)</label>
            <input id="na-notes" maxLength={300} className="input" value={notes} onChange={(e) => setNotes(e.target.value)} />
            <p className="mt-1 text-xs text-stone-500">Não registre informações de saúde aqui.</p>
          </div>
          {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
          <div className="flex justify-end gap-2">
            <button type="button" className="btn-ghost" onClick={onClose}>Cancelar</button>
            <button className="btn-primary" disabled={busy || !effectiveProfessional}>{busy ? "Agendando..." : "Agendar"}</button>
          </div>
        </form>
      )}
    </Modal>
  );
}

export function AppointmentModal({
  appointment,
  today,
  onClose,
  onChanged,
}: {
  appointment: OwnerAppointment;
  today: string;
  onClose: () => void;
  onChanged: () => void;
}) {
  const { business, catalog } = useBusiness();
  const [mode, setMode] = useState<"view" | "reschedule" | "cancel">("view");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [date, setDate] = useState(appointment.date);
  const [professionalId, setProfessionalId] = useState(appointment.professional_id);
  const [choice, setChoice] = useState<Choice>(null);
  const [origin, setOrigin] = useState("");

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setOrigin(window.location.origin);
  }, []);

  const professional = catalog.professionals.find((p) => p.id === appointment.professional_id);
  const open = appointment.status === "pending" || appointment.status === "confirmed";
  const link = `${origin}/${business.slug}/agendamento/${appointment.public_token}`;
  const when = `${friendlyDate(appointment.date, today)} às ${appointment.time}`;
  const message =
    `Olá, ${appointment.customer_name.split(" ")[0]}! Aqui é de ${business.name}. ` +
    `Seu horário de ${appointment.service_name} está marcado para ${when}. ` +
    `Para ver, remarcar ou cancelar: ${link}`;
  const able = catalog.professionals.filter(
    (p) => p.id === appointment.professional_id || (p.is_active && appointment.service_id && p.service_ids.includes(appointment.service_id)),
  );

  async function run(call: () => PromiseLike<{ error: { code?: string; message?: string } | null }>, close = true) {
    setBusy(true);
    setError(null);
    const { error } = await call();
    setBusy(false);
    if (error) return setError(errorMessage(error, "Não foi possível concluir."));
    // Cancelamento de agendamento com sinal pago: o servidor faz o estorno.
    if (appointment.payment_status === "paid") {
      await fetch("/api/painel/pagamentos/pendencias", { method: "POST" }).catch(() => null);
    }
    onChanged();
    if (close) onClose();
    else setMode("view");
  }

  const setStatus = (status: string, why?: string) =>
    run(() =>
      createClient().rpc("owner_set_appointment_status", {
        p_appointment_id: appointment.id,
        p_status: status,
        p_reason: why ?? null,
      }),
    );

  return (
    <Modal title={`${appointment.customer_name} · ${appointment.time}`} onClose={onClose}>
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          <span className={`chip ${
            appointment.status === "pending" ? "bg-amber-100 text-amber-900"
              : appointment.status === "confirmed" ? "bg-green-100 text-green-800"
                : appointment.status === "completed" ? "bg-stone-200 text-stone-700" : "bg-red-100 text-red-800"
          }`}>
            {STATUS_LABEL[appointment.status]}
          </span>
          <span className="chip bg-stone-100 text-stone-600">Feito por: {SOURCE_LABEL[appointment.source]}</span>
        </div>

        <dl className="space-y-1.5 rounded-xl bg-stone-50 px-4 py-3 text-sm">
          <Line label="Serviço">{appointment.service_name} · {durationLabel(appointment.duration_minutes)} · {brl(appointment.price_cents)}</Line>
          <Line label="Quando">{when} (até {appointment.end_time})</Line>
          <Line label="Profissional">{professional?.name ?? "—"}</Line>
          <Line label="WhatsApp">
            <a className="text-brand underline" target="_blank" rel="noreferrer" href={whatsappLink(appointment.customer_phone)}>
              {formatPhone(appointment.customer_phone)}
            </a>
          </Line>
          {appointment.notes && <Line label="Observação">{appointment.notes}</Line>}
          {appointment.status === "canceled" && (
            <Line label="Cancelado por">
              {appointment.canceled_by === "customer" ? "cliente" : "estabelecimento"}
              {appointment.cancel_reason ? ` — ${appointment.cancel_reason}` : ""}
            </Line>
          )}
          {(appointment.payment_status !== "none" || (business.pix_key && appointment.deposit_cents > 0)) && (
            <Line label="Pagamento">
              {PAYMENT_STATUS_LABEL[appointment.payment_status]}
              {appointment.deposit_cents > 0 ? ` (sinal de ${brl(appointment.deposit_cents)})` : ""}
            </Line>
          )}
          <Line label="Criado em">{dateTimeInSaoPaulo(appointment.created_at)}</Line>
        </dl>

        {error && <p role="alert" className="text-sm text-red-700">{error}</p>}

        {mode === "view" && (
          <>
            <div className="flex flex-wrap gap-2">
              {appointment.status === "pending" && (
                <button className="btn-primary flex-1" disabled={busy} onClick={() => setStatus("confirmed")}>Confirmar</button>
              )}
              {open && appointment.is_past && (
                <>
                  <button className="btn-primary flex-1" disabled={busy} onClick={() => setStatus("completed")}>Concluído</button>
                  <button className="btn-outline flex-1" disabled={busy} onClick={() => setStatus("no_show")}>Faltou</button>
                </>
              )}
              {open && (
                <>
                  <button className="btn-outline flex-1" disabled={busy} onClick={() => { setError(null); setMode("reschedule"); }}>Remarcar</button>
                  <button className="btn-danger flex-1" disabled={busy} onClick={() => { setError(null); setMode("cancel"); }}>Cancelar</button>
                </>
              )}
              {appointment.status === "completed" && (
                <button className="btn-outline flex-1" disabled={busy} onClick={() => setStatus("no_show")}>Na verdade, faltou</button>
              )}
              {appointment.status === "no_show" && (
                <button className="btn-outline flex-1" disabled={busy} onClick={() => setStatus("completed")}>Na verdade, veio</button>
              )}
              {!open && (
                <button className="btn-outline flex-1" disabled={busy} onClick={() => setStatus("confirmed")}>
                  {appointment.status === "canceled" ? "Reativar" : "Desfazer baixa"}
                </button>
              )}
            </div>
            {/* Pix copia e cola (cobrança desligada): quem confere o recebimento é o dono. */}
            {appointment.status !== "canceled" && ["none", "manual_paid"].includes(appointment.payment_status) && appointment.deposit_cents > 0 && business.pix_key && (
              <button className="btn-outline w-full" disabled={busy}
                onClick={() =>
                  run(
                    () => createClient().rpc("owner_mark_paid", { p_appointment_id: appointment.id, p_paid: appointment.payment_status === "none" }),
                    false,
                  )
                }>
                {appointment.payment_status === "none" ? "Marcar pagamento recebido" : "Desfazer pagamento recebido"}
              </button>
            )}
            {open && (
              <a className="btn-outline w-full" target="_blank" rel="noreferrer" href={whatsappLink(appointment.customer_phone, message)}>
                Enviar confirmação e link pelo WhatsApp
              </a>
            )}
          </>
        )}

        {mode === "cancel" && (
          <form className="space-y-3"
            onSubmit={(event) => {
              event.preventDefault();
              setStatus("canceled", reason);
            }}>
            <div>
              <label className="label" htmlFor="am-reason">Motivo (o cliente vê no link dele)</label>
              <input id="am-reason" className="input" maxLength={200} value={reason} onChange={(e) => setReason(e.target.value)} />
            </div>
            <div className="flex justify-end gap-2">
              <button type="button" className="btn-ghost" onClick={() => setMode("view")}>Voltar</button>
              <button className="btn-danger" disabled={busy}>{busy ? "Cancelando..." : "Cancelar agendamento"}</button>
            </div>
          </form>
        )}

        {mode === "reschedule" && (
          <form className="space-y-3"
            onSubmit={(event) => {
              event.preventDefault();
              if (!choice) return setError("Escolha o novo horário.");
              run(
                () =>
                  createClient().rpc("owner_reschedule_appointment", {
                    p: { appointment_id: appointment.id, professional_id: professionalId, ...choicePayload(choice, date) },
                  }),
                true,
              );
            }}>
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <label className="label" htmlFor="am-date">Novo dia</label>
                <input id="am-date" type="date" required className="input" value={date}
                  onChange={(e) => e.target.value && setDate(e.target.value)} />
              </div>
              <div>
                <label className="label" htmlFor="am-professional">Profissional</label>
                <select id="am-professional" className="input" value={professionalId} onChange={(e) => setProfessionalId(e.target.value)}>
                  {able.map((p) => (
                    <option key={p.id} value={p.id}>{p.name}</option>
                  ))}
                </select>
              </div>
            </div>
            {appointment.service_id ? (
              <OwnerSlotChooser serviceId={appointment.service_id} professionalId={professionalId} date={date}
                ignoreAppointment={appointment.id} onChange={setChoice} />
            ) : (
              <div>
                <p className="mb-1 text-sm text-stone-600">O serviço deste agendamento foi apagado: informe o horário (encaixe).</p>
                <input type="time" aria-label="Novo horário" className="input w-auto"
                  onChange={(e) => setChoice(e.target.value ? { time: e.target.value, force: true } : null)} />
              </div>
            )}
            <div className="flex justify-end gap-2">
              <button type="button" className="btn-ghost" onClick={() => setMode("view")}>Voltar</button>
              <button className="btn-primary" disabled={busy || !choice}>{busy ? "Remarcando..." : "Remarcar"}</button>
            </div>
          </form>
        )}
      </div>
    </Modal>
  );
}

function Line({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-4">
      <dt className="shrink-0 text-stone-500">{label}</dt>
      <dd className="text-right font-medium">{children}</dd>
    </div>
  );
}

export function BlockModal({ date, onClose, onCreated }: { date: string; onClose: () => void; onCreated: () => void }) {
  const { business, catalog } = useBusiness();
  const [professionalId, setProfessionalId] = useState("");
  const [allDay, setAllDay] = useState(false);
  const [startDate, setStartDate] = useState(date);
  const [endDate, setEndDate] = useState(date);
  const [startTime, setStartTime] = useState("12:00");
  const [endTime, setEndTime] = useState("13:00");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conflicts, setConflicts] = useState<number | null>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    // Dia inteiro: da meia-noite do primeiro dia até a meia-noite seguinte ao último. O banco converte o fuso.
    const lastDay = endDate < startDate ? startDate : endDate;
    const { data, error } = await createClient().rpc("owner_create_block", {
      p_business_id: business.id,
      p_professional_id: professionalId || null,
      p_start_date: startDate,
      p_start_time: allDay ? "00:00" : startTime,
      p_end_date: allDay ? nextDay(lastDay) : lastDay,
      p_end_time: allDay ? "00:00" : endTime,
      p_reason: reason,
    });
    setBusy(false);
    if (error) return setError(errorMessage(error, "Não foi possível bloquear."));
    onCreated();
    const count = (data as { conflicts: number }).conflicts;
    if (count > 0) setConflicts(count);
    else onClose();
  }

  if (conflicts !== null) {
    return (
      <Modal title="Bloqueio criado" onClose={onClose}>
        <p className="text-sm text-stone-700">
          O período foi bloqueado para novos agendamentos, mas {conflicts === 1 ? "já existe 1 agendamento" : `já existem ${conflicts} agendamentos`} nele.
          O bloqueio não cancela ninguém: abra cada um na agenda para remarcar ou cancelar.
        </p>
        <button className="btn-primary mt-4 w-full" onClick={onClose}>Entendi</button>
      </Modal>
    );
  }

  return (
    <Modal title="Bloquear horário" onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        <div>
          <label className="label" htmlFor="bm-professional">Quem</label>
          <select id="bm-professional" className="input" value={professionalId} onChange={(e) => setProfessionalId(e.target.value)}>
            <option value="">Todos (o estabelecimento inteiro)</option>
            {catalog.professionals.filter((p) => p.is_active).map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={allDay} onChange={(e) => setAllDay(e.target.checked)} />
          Dia inteiro (folga, feriado, férias)
        </label>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="label" htmlFor="bm-start-date">{allDay ? "Do dia" : "Dia"}</label>
            <input id="bm-start-date" type="date" required className="input" value={startDate}
              onChange={(e) => {
                setStartDate(e.target.value);
                if (!allDay || e.target.value > endDate) setEndDate(e.target.value);
              }} />
          </div>
          {allDay ? (
            <div>
              <label className="label" htmlFor="bm-end-date">Até o dia</label>
              <input id="bm-end-date" type="date" required className="input" min={startDate} value={endDate}
                onChange={(e) => setEndDate(e.target.value)} />
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="label" htmlFor="bm-start-time">Das</label>
                <input id="bm-start-time" type="time" required className="input" value={startTime} onChange={(e) => setStartTime(e.target.value)} />
              </div>
              <div>
                <label className="label" htmlFor="bm-end-time">Às</label>
                <input id="bm-end-time" type="time" required className="input" value={endTime} onChange={(e) => setEndTime(e.target.value)} />
              </div>
            </div>
          )}
        </div>
        <div>
          <label className="label" htmlFor="bm-reason">Motivo (só você vê)</label>
          <input id="bm-reason" className="input" maxLength={120} placeholder="Ex.: almoço, curso, feriado" value={reason}
            onChange={(e) => setReason(e.target.value)} />
        </div>
        {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" className="btn-ghost" onClick={onClose}>Cancelar</button>
          <button className="btn-primary" disabled={busy}>{busy ? "Bloqueando..." : "Bloquear"}</button>
        </div>
      </form>
    </Modal>
  );
}

function nextDay(date: string) {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day + 1)).toISOString().slice(0, 10);
}
