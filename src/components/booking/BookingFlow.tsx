"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { InstallPrompt } from "@/components/InstallGuide";
import { STORAGE_PREFIX } from "@/lib/brand";
import { brandStyle } from "@/lib/color";
import { friendlyDate, hm, WEEKDAYS } from "@/lib/dates";
import {
  brl,
  depositFor,
  durationLabel,
  errorMessage,
  formatPhone,
  groupByCategory,
  normalizePhone,
  noticeLabel,
  priceLabel,
  whatsappLink,
} from "@/lib/format";
import { createClient } from "@/lib/supabase/client";
import type { BookedAppointment, Catalog, PublicAppointment, Service, Slot } from "@/lib/types";
import { BusinessHeader } from "./BusinessHeader";
import { ChatWidget } from "./ChatWidget";
import { SlotPicker } from "./SlotPicker";
import {
  forgetAppointment,
  loadAppointments,
  loadCustomer,
  saveAppointment,
  saveCustomer,
  type SavedAppointment,
} from "./storage";

type Step = "service" | "professional" | "time" | "details" | "done";

/** Página pública: o cliente agenda sem baixar app e sem criar conta. */
export function BookingFlow({ catalog, today, chat }: { catalog: Catalog; today: string; chat: boolean }) {
  const { business, services, professionals } = catalog;
  const supabase = useMemo(() => createClient(), []);
  const router = useRouter();

  const [step, setStep] = useState<Step>("service");
  const [service, setService] = useState<Service | null>(null);
  const [professionalId, setProfessionalId] = useState<string | null>(null);
  const [slot, setSlot] = useState<{ slot: Slot; date: string } | null>(null);
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [booked, setBooked] = useState<BookedAppointment | null>(null);
  const [mine, setMine] = useState<SavedAppointment[]>([]);
  const top = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // O que está guardado no aparelho só existe no navegador; carregar depois da hidratação evita
    // divergência com o HTML do servidor.
    const customer = loadCustomer();
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setName(customer.name);
    setPhone(customer.phone ? formatPhone(customer.phone) : "");

    // Agendamentos feitos neste aparelho: confere a situação de cada um e esquece os encerrados.
    let active = true;
    const saved = loadAppointments(business.slug);
    Promise.all(
      saved.map(async (item) => {
        const { data } = await supabase.rpc("get_appointment", { p_token: item.token });
        const appointment = data as PublicAppointment | null;
        if (!appointment || appointment.is_past || !["pending", "confirmed"].includes(appointment.status)) {
          forgetAppointment(business.slug, item.token);
          return null;
        }
        return { token: item.token, date: appointment.date, time: appointment.time, service: appointment.service_name };
      }),
    ).then((list) => {
      if (active) setMine(list.filter((item): item is SavedAppointment => item !== null));
    });
    return () => {
      active = false;
    };
  }, [business.slug, supabase]);

  const capable = useMemo(
    () => (service ? professionals.filter((p) => p.service_ids.includes(service.id)) : []),
    [professionals, service],
  );
  const asksProfessional = business.choose_professional && capable.length > 1;
  const professional = capable.find((p) => p.id === professionalId) ?? null;

  function go(next: Step) {
    setError(null);
    setStep(next);
    top.current?.scrollIntoView({ block: "start", behavior: "smooth" });
  }

  function chooseService(chosen: Service) {
    setService(chosen);
    setProfessionalId(null);
    setSlot(null);
    const options = professionals.filter((p) => p.service_ids.includes(chosen.id));
    go(business.choose_professional && options.length > 1 ? "professional" : "time");
  }

  async function confirm(event: React.FormEvent) {
    event.preventDefault();
    if (!service || !slot) return;
    const digits = normalizePhone(phone);
    if (name.trim().length < 2) return setError("Informe seu nome.");
    if (!digits) return setError("Informe seu WhatsApp com DDD. Ex.: (11) 99999-9999");
    setBusy(true);
    setError(null);
    const { data, error } = await supabase.rpc("book_appointment", {
      p: {
        business_id: business.id,
        service_id: service.id,
        professional_id: professionalId,
        starts_at: slot.slot.at,
        customer_name: name,
        customer_phone: digits,
        notes,
        source: "web",
      },
    });
    setBusy(false);
    if (error) {
      setError(errorMessage(error, "Não foi possível agendar agora. Tente de novo em instantes."));
      if (error.code === "AG409") {
        // Outra pessoa ficou com o horário: volta para a escolha, com a lista atualizada.
        setSlot(null);
        setRefreshKey((key) => key + 1);
        setStep("time");
      }
      return;
    }
    const created = data as BookedAppointment;
    saveCustomer({ name: name.trim(), phone: digits });
    saveAppointment(business.slug, {
      token: created.token,
      date: created.date,
      time: created.time,
      service: created.service_name,
    });
    // Cobrança ligada: o agendamento nasce aguardando o sinal; a página dele mostra o Pix.
    if (business.charge_on_booking && depositFor(business, created.price_cents) > 0) {
      router.push(`/${business.slug}/agendamento/${created.token}`);
      return;
    }
    setBooked(created);
    go("done");
  }

  const businessHours = catalog.hours.filter((h) => h.professional_id === null);

  return (
    <div style={brandStyle(business.primary_color)} className="flex flex-1 flex-col">
      <BusinessHeader business={business}>
        <div className="mt-4 flex flex-wrap gap-2 text-xs font-medium">
          <span className="chip bg-black/15">{business.is_accepting ? "Agendamento online" : "Agenda online fechada"}</span>
          {business.address && <span className="chip bg-black/15">{business.address}</span>}
        </div>
      </BusinessHeader>

      <main className="mx-auto w-full max-w-2xl flex-1 space-y-4 px-4 pb-28 pt-4">
        <div ref={top} className="scroll-mt-4" />
        <InstallPrompt
          variant="banner"
          appName={business.name}
          storageKey={`${STORAGE_PREFIX}:instalar:${business.slug}`}
        />

        {step !== "done" &&
          mine.map((item) => (
            <Link
              key={item.token}
              href={`/${business.slug}/agendamento/${item.token}`}
              className="card flex items-center justify-between gap-3 px-4 py-3 text-sm"
            >
              <span>
                Você tem <span className="font-semibold">{item.service}</span> marcado para{" "}
                <span className="font-semibold">
                  {friendlyDate(item.date, today)} às {item.time}
                </span>
                .
              </span>
              <span className="shrink-0 font-semibold text-brand">Ver →</span>
            </Link>
          ))}

        {!business.is_accepting ? (
          <section className="card p-5">
            <h1 className="text-lg font-bold">Agenda online fechada no momento</h1>
            <p className="mt-1 text-sm text-stone-600">
              {business.name} não está recebendo agendamentos pelo site agora.
              {business.phone ? " Fale direto com o estabelecimento:" : ""}
            </p>
            {business.phone && (
              <a className="btn-primary mt-4" target="_blank" rel="noreferrer" href={whatsappLink(business.phone, "Olá! Gostaria de agendar um horário.")}>
                Chamar no WhatsApp
              </a>
            )}
          </section>
        ) : services.length === 0 ? (
          <p className="card px-5 py-10 text-center text-sm text-stone-600">
            {business.name} ainda está montando a agenda online. Volte em breve.
          </p>
        ) : step === "done" && booked ? (
          <Done business={business} booked={booked} today={today} />
        ) : (
          <>
            {/* 1. Serviço */}
            {step === "service" ? (
              <section className="card p-5" aria-labelledby="step-service">
                <h1 id="step-service" className="text-lg font-bold">O que você quer agendar?</h1>
                <div className="mt-3 space-y-5">
                  {groupByCategory(services).map((group) => (
                    <div key={group.category ?? ""}>
                      {group.category && (
                        <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-stone-500">{group.category}</h2>
                      )}
                      <ul className="space-y-2">
                        {group.items.map((item) => (
                          <li key={item.id}>
                            <button
                              type="button"
                              onClick={() => chooseService(item)}
                              className="flex w-full items-start justify-between gap-3 rounded-xl border border-stone-200 bg-white px-4 py-3 text-left transition hover:border-brand"
                            >
                              <span className="min-w-0">
                                <span className="block font-semibold">{item.name}</span>
                                {item.description && (
                                  <span className="mt-0.5 block text-sm text-stone-600">{item.description}</span>
                                )}
                                <span className="mt-0.5 block text-sm text-stone-500">{durationLabel(item.duration_minutes)}</span>
                              </span>
                              <span className="shrink-0 text-sm font-semibold text-brand">{priceLabel(item)}</span>
                            </button>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ))}
                </div>
              </section>
            ) : (
              service && (
                <Summary label="Serviço" onChange={() => go("service")}>
                  {service.name} · {durationLabel(service.duration_minutes)} · {priceLabel(service)}
                </Summary>
              )
            )}

            {/* 2. Profissional */}
            {service && asksProfessional && step === "professional" && (
              <section className="card p-5" aria-labelledby="step-professional">
                <h1 id="step-professional" className="text-lg font-bold">Com quem?</h1>
                <ul className="mt-3 space-y-2">
                  <li>
                    <ProfessionalOption
                      title="Qualquer profissional"
                      subtitle="Mostra todos os horários livres"
                      onClick={() => {
                        setProfessionalId(null);
                        setSlot(null);
                        go("time");
                      }}
                    />
                  </li>
                  {capable.map((item) => (
                    <li key={item.id}>
                      <ProfessionalOption
                        title={item.name}
                        subtitle={item.role}
                        onClick={() => {
                          setProfessionalId(item.id);
                          setSlot(null);
                          go("time");
                        }}
                      />
                    </li>
                  ))}
                </ul>
              </section>
            )}
            {service && asksProfessional && (step === "time" || step === "details") && (
              <Summary label="Profissional" onChange={() => go("professional")}>
                {professional ? professional.name : "Qualquer profissional"}
              </Summary>
            )}

            {/* 3. Dia e horário */}
            {service && step === "time" && (
              <section className="card p-5" aria-labelledby="step-time">
                <h1 id="step-time" className="text-lg font-bold">Quando?</h1>
                {error && <p role="alert" className="mt-2 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800">{error}</p>}
                <div className="mt-3">
                  <SlotPicker
                    businessId={business.id}
                    serviceId={service.id}
                    professionalId={professionalId}
                    refreshKey={refreshKey}
                    selected={slot?.slot ?? null}
                    onSelect={(chosen, date) => {
                      setSlot({ slot: chosen, date });
                      go("details");
                    }}
                  />
                </div>
              </section>
            )}
            {service && slot && step === "details" && (
              <Summary label="Horário" onChange={() => go("time")}>
                {friendlyDate(slot.date, today)} às {slot.slot.time}
              </Summary>
            )}

            {/* 4. Dados e confirmação */}
            {service && slot && step === "details" && (
              <form onSubmit={confirm} className="card space-y-4 p-5" aria-labelledby="step-details">
                <h1 id="step-details" className="text-lg font-bold">Seus dados</h1>
                <div>
                  <label className="label" htmlFor="customer-name">Nome</label>
                  <input id="customer-name" required minLength={2} maxLength={80} autoComplete="name" className="input"
                    value={name} onChange={(e) => setName(e.target.value)} />
                </div>
                <div>
                  <label className="label" htmlFor="customer-phone">WhatsApp com DDD</label>
                  <input id="customer-phone" required inputMode="tel" autoComplete="tel" className="input"
                    placeholder="(11) 99999-9999" maxLength={20}
                    value={phone} onChange={(e) => setPhone(maskPhone(e.target.value))} />
                </div>
                <div>
                  <label className="label" htmlFor="customer-notes">Observação (opcional)</label>
                  <textarea id="customer-notes" rows={2} maxLength={300} className="input"
                    placeholder="Algo que o estabelecimento precisa saber sobre o horário"
                    value={notes} onChange={(e) => setNotes(e.target.value)} />
                  <p className="mt-1 text-xs text-stone-500">
                    Não escreva informações de saúde aqui. Se precisar tratar disso, fale direto com o estabelecimento.
                  </p>
                </div>
                {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
                {business.charge_on_booking && depositFor(business, service.price_cents) > 0 && (
                  <p className="rounded-lg bg-amber-50 px-3 py-2.5 text-sm text-amber-900">
                    Para confirmar este horário é cobrado um sinal de{" "}
                    <span className="font-semibold">{brl(depositFor(business, service.price_cents))}</span> via Pix, na
                    próxima tela. O horário fica reservado por {business.hold_minutes} minutos enquanto você paga.
                  </p>
                )}
                <button className="btn-primary w-full py-3 text-base" disabled={busy}>
                  {busy
                    ? "Agendando..."
                    : business.charge_on_booking && depositFor(business, service.price_cents) > 0
                      ? "Reservar e pagar o sinal"
                      : "Confirmar agendamento"}
                </button>
                <p className="text-xs text-stone-500">
                  {business.auto_confirm
                    ? "Ao confirmar, o horário fica reservado para você."
                    : "Ao confirmar, o horário fica reservado e o estabelecimento confirma em seguida."}{" "}
                  {business.cancel_notice_minutes > 0
                    ? `Você pode remarcar ou cancelar pelo link do agendamento até ${noticeLabel(business.cancel_notice_minutes)} antes.`
                    : "Você pode remarcar ou cancelar pelo link do agendamento."}{" "}
                  Seu nome e WhatsApp são usados só para este agendamento e para o contato do estabelecimento.
                </p>
              </form>
            )}
          </>
        )}

        {step !== "done" && businessHours.length > 0 && (
          <section className="px-1 pt-2 text-sm text-stone-600">
            <h2 className="font-semibold text-stone-800">Horário de funcionamento</h2>
            <dl className="mt-1.5 grid grid-cols-[auto_1fr] gap-x-4 gap-y-0.5">
              {WEEKDAYS.map((label, weekday) => {
                const periods = businessHours.filter((h) => h.weekday === weekday);
                return (
                  <div key={label} className="contents">
                    <dt>{label}</dt>
                    <dd>
                      {periods.length
                        ? periods.map((h) => `${hm(h.start_time)} às ${hm(h.end_time)}`).join(" e ")
                        : "Fechado"}
                    </dd>
                  </div>
                );
              })}
            </dl>
            {business.phone && (
              <p className="mt-3">
                Dúvidas?{" "}
                <a className="font-semibold text-brand underline" target="_blank" rel="noreferrer" href={whatsappLink(business.phone)}>
                  Fale com {business.name} pelo WhatsApp
                </a>
                .
              </p>
            )}
          </section>
        )}
      </main>
      {chat && business.is_accepting && services.length > 0 && <ChatWidget business={business} />}
    </div>
  );
}

function Summary({ label, onChange, children }: { label: string; onChange: () => void; children: React.ReactNode }) {
  return (
    <div className="card flex items-center justify-between gap-3 px-4 py-3 text-sm">
      <p className="min-w-0">
        <span className="block text-xs text-stone-500">{label}</span>
        <span className="font-semibold">{children}</span>
      </p>
      <button type="button" onClick={onChange} className="shrink-0 font-semibold text-brand">
        Trocar
      </button>
    </div>
  );
}

function ProfessionalOption({ title, subtitle, onClick }: { title: string; subtitle?: string | null; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center gap-3 rounded-xl border border-stone-200 bg-white px-4 py-3 text-left transition hover:border-brand"
    >
      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-brand/10 font-bold text-brand" aria-hidden>
        {title.replace(/^(Dra?\.?|Sra?\.?)\s+/i, "").charAt(0).toUpperCase()}
      </span>
      <span className="min-w-0">
        <span className="block font-semibold">{title}</span>
        {subtitle && <span className="block text-sm text-stone-600">{subtitle}</span>}
      </span>
    </button>
  );
}

function Done({ business, booked, today }: { business: Catalog["business"]; booked: BookedAppointment; today: string }) {
  const [link, setLink] = useState("");
  const [copied, setCopied] = useState(false);
  const confirmed = booked.status === "confirmed";
  const path = `/${business.slug}/agendamento/${booked.token}`;

  useEffect(() => {
    // O endereço completo só existe no navegador.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLink(`${window.location.origin}${path}`);
  }, [path]);

  const text = `Meu agendamento em ${business.name}: ${booked.service_name}, ${friendlyDate(booked.date, today)} às ${booked.time}. Para ver, remarcar ou cancelar: ${link}`;

  return (
    <section className="card p-5" aria-live="polite">
      <p className={`chip ${confirmed ? "bg-green-100 text-green-800" : "bg-amber-100 text-amber-900"}`}>
        {confirmed ? "Confirmado" : "Aguardando confirmação"}
      </p>
      <h1 className="mt-3 text-xl font-bold">{confirmed ? "Agendamento confirmado!" : "Pedido de agendamento enviado"}</h1>
      <p className="mt-1 text-sm text-stone-600">
        {confirmed
          ? "Seu horário está reservado."
          : `Seu horário está reservado. ${business.name} vai confirmar em seguida; a situação aparece no link do agendamento.`}
      </p>

      <dl className="mt-4 space-y-2 rounded-xl bg-stone-50 px-4 py-3 text-sm">
        <Row label="Serviço">{booked.service_name}</Row>
        <Row label="Quando">
          {friendlyDate(booked.date, today)} às {booked.time}
        </Row>
        <Row label="Com">{booked.professional_name}</Row>
        {business.address && <Row label="Onde">{business.address}</Row>}
        <Row label="Valor">{priceLabel({ price_cents: booked.price_cents, price_from: false })}</Row>
      </dl>

      {business.booking_notice && (
        <p className="mt-4 whitespace-pre-line rounded-xl border border-stone-200 px-4 py-3 text-sm text-stone-700">
          {business.booking_notice}
        </p>
      )}

      <div className="mt-5 flex flex-col gap-2">
        <Link href={path} className="btn-primary py-3">Ver, remarcar ou cancelar</Link>
        <a className="btn-outline" target="_blank" rel="noreferrer" href={`https://wa.me/?text=${encodeURIComponent(text)}`}>
          Guardar o link no meu WhatsApp
        </a>
        <button
          type="button"
          className="btn-ghost"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(link);
              setCopied(true);
              setTimeout(() => setCopied(false), 2000);
            } catch {
              // Sem permissão para copiar: o link continua no botão acima.
            }
          }}
        >
          {copied ? "Link copiado" : "Copiar link do agendamento"}
        </button>
      </div>
      <p className="mt-3 text-xs text-stone-500">
        Guarde este link: é por ele que você remarca ou cancela. Quem tiver o link consegue ver o agendamento.
      </p>
    </section>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-4">
      <dt className="text-stone-500">{label}</dt>
      <dd className="text-right font-medium">{children}</dd>
    </div>
  );
}

/** Máscara enquanto digita: (11) 99999-9999. Aceita colar com +55. */
export function maskPhone(value: string) {
  let digits = value.replace(/\D/g, "");
  if (digits.length > 11 && digits.startsWith("55")) digits = digits.slice(2);
  digits = digits.slice(0, 11);
  if (digits.length <= 2) return digits.length ? `(${digits}` : "";
  if (digits.length <= 6) return `(${digits.slice(0, 2)}) ${digits.slice(2)}`;
  if (digits.length <= 10) return `(${digits.slice(0, 2)}) ${digits.slice(2, 6)}-${digits.slice(6)}`;
  return `(${digits.slice(0, 2)}) ${digits.slice(2, 7)}-${digits.slice(7)}`;
}
