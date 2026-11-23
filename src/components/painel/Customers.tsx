"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Modal } from "@/components/Modal";
import { dateInSaoPaulo, diffDays, formatDateFull, timeInSaoPaulo } from "@/lib/dates";
import { brl, formatPhone, STATUS_LABEL, whatsappLink } from "@/lib/format";
import { createClient } from "@/lib/supabase/client";
import type { AppointmentStatus, CustomerSummary } from "@/lib/types";
import { NewAppointmentModal } from "./AgendaModals";
import { DATA_CHANGED, useBusiness } from "./BusinessContext";

/** Sem aparecer há este tanto de dias (e sem horário futuro) = cliente que sumiu. */
const AWAY_DAYS = 45;

type Row = CustomerSummary & { daysAway: number | null; away: boolean };

export function Customers() {
  const { business, today } = useBusiness();
  const supabase = useMemo(() => createClient(), []);
  const [customers, setCustomers] = useState<Row[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [onlyAway, setOnlyAway] = useState(false);
  const [opened, setOpened] = useState<string | null>(null);
  const [winback, setWinback] = useState<Row | null>(null);

  const load = useCallback(async () => {
    const { data, error } = await supabase.rpc("owner_customers", { p_business_id: business.id });
    if (error) return setError("Não foi possível carregar os clientes.");
    setError(null);
    setCustomers(
      ((data ?? []) as CustomerSummary[]).map((c) => {
        const daysAway = c.last_visit_at ? diffDays(dateInSaoPaulo(c.last_visit_at), today) : null;
        return { ...c, daysAway, away: daysAway !== null && daysAway >= AWAY_DAYS && c.upcoming === 0 };
      }),
    );
  }, [supabase, business.id, today]);

  useEffect(() => {
    const first = setTimeout(load, 0);
    window.addEventListener(DATA_CHANGED, load);
    return () => {
      clearTimeout(first);
      window.removeEventListener(DATA_CHANGED, load);
    };
  }, [load]);

  const term = search.trim().toLowerCase();
  const digits = term.replace(/\D/g, "");
  const visible = (customers ?? []).filter(
    (c) =>
      (!onlyAway || c.away) &&
      (!term || c.name.toLowerCase().includes(term) || (digits.length > 0 && c.phone.includes(digits))),
  );
  const awayCount = (customers ?? []).filter((c) => c.away).length;
  const current = customers?.find((c) => c.id === opened) ?? null;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold">Clientes</h1>
          <p className="text-sm text-stone-600">Quem já agendou, com atendimentos, faltas e quem sumiu.</p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={onlyAway} onChange={(e) => setOnlyAway(e.target.checked)} />
            Só quem sumiu há {AWAY_DAYS} dias ou mais ({awayCount})
          </label>
          <input className="input w-56" placeholder="Buscar por nome ou telefone" aria-label="Buscar cliente"
            value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
      </div>

      {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
      {customers === null && !error && <p className="text-sm text-stone-500">Carregando clientes...</p>}
      {customers !== null && visible.length === 0 && (
        <p className="card px-5 py-8 text-center text-sm text-stone-600">
          {customers.length === 0
            ? "Os clientes aparecem aqui depois do primeiro agendamento."
            : onlyAway ? "Nenhum cliente sumido. Bom sinal." : "Nenhum cliente encontrado."}
        </p>
      )}

      {visible.length > 0 && (
        <ul className="card divide-y divide-stone-100">
          {visible.map((customer) => (
            <li key={customer.id} className="flex flex-wrap items-center gap-x-5 gap-y-2 px-4 py-3 text-sm">
              <button className="min-w-0 flex-1 text-left" onClick={() => setOpened(customer.id)}>
                <span className="block font-semibold">{customer.name}</span>
                <span className="block text-stone-500">
                  {formatPhone(customer.phone)}
                  {customer.favorite_service && ` · costuma fazer ${customer.favorite_service}`}
                </span>
              </button>
              <span className="text-stone-600">
                {customer.completed} {customer.completed === 1 ? "atendimento" : "atendimentos"}
                {customer.no_shows > 0 && (
                  <span className="font-medium text-red-700"> · {customer.no_shows} {customer.no_shows === 1 ? "falta" : "faltas"}</span>
                )}
              </span>
              <span className={customer.away ? "font-medium text-amber-700" : "text-stone-500"}>
                {customer.upcoming > 0
                  ? "tem horário marcado"
                  : customer.daysAway === null
                    ? "ainda não veio"
                    : customer.daysAway === 0 ? "veio hoje" : `há ${customer.daysAway} ${customer.daysAway === 1 ? "dia" : "dias"}`}
              </span>
              <button className="btn-outline py-1.5" onClick={() => setWinback(customer)}>Chamar de volta</button>
            </li>
          ))}
        </ul>
      )}

      {current && <CustomerModal customer={current} onClose={() => setOpened(null)} onChanged={load} />}
      {winback && <WinbackModal customer={winback} onClose={() => setWinback(null)} />}
    </div>
  );
}

type HistoryRow = { id: string; service_name: string; starts_at: string; status: AppointmentStatus; price_cents: number };

function CustomerModal({ customer, onClose, onChanged }: { customer: Row; onClose: () => void; onChanged: () => void }) {
  const { today } = useBusiness();
  const supabase = useMemo(() => createClient(), []);
  const [history, setHistory] = useState<HistoryRow[] | null>(null);
  const [name, setName] = useState(customer.name);
  const [notes, setNotes] = useState(customer.notes ?? "");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [booking, setBooking] = useState(false);

  useEffect(() => {
    let active = true;
    supabase
      .from("appointments")
      .select("id, service_name, starts_at, status, price_cents")
      .eq("customer_id", customer.id)
      .order("starts_at", { ascending: false })
      .limit(100)
      .then(({ data }) => active && setHistory((data ?? []) as HistoryRow[]));
    return () => {
      active = false;
    };
  }, [supabase, customer.id]);

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    const { error } = await supabase.from("customers").update({ name: name.trim(), notes: notes.trim() || null }).eq("id", customer.id);
    setBusy(false);
    if (error) return setMessage({ ok: false, text: "Não foi possível salvar." });
    setMessage({ ok: true, text: "Salvo." });
    onChanged();
  }

  async function remove() {
    if (!window.confirm(`Apagar ${customer.name} e todo o histórico de agendamentos? Isso não pode ser desfeito.`)) return;
    setBusy(true);
    const { error } = await supabase.from("customers").delete().eq("id", customer.id);
    setBusy(false);
    if (error) return setMessage({ ok: false, text: "Não foi possível apagar." });
    onChanged();
    onClose();
  }

  if (booking) {
    return <NewAppointmentModal date={today} customer={customer} onClose={onClose} onCreated={onChanged} />;
  }

  return (
    <Modal title={customer.name} onClose={onClose}>
      <div className="space-y-5">
        <div className="grid grid-cols-4 gap-2 text-center text-sm">
          {[
            ["Atendimentos", customer.completed],
            ["Faltas", customer.no_shows],
            ["Cancelou", customer.canceled],
            ["Gasto", brl(customer.spent_cents)],
          ].map(([label, value]) => (
            <div key={label} className="rounded-lg bg-stone-50 px-1 py-2">
              <p className="font-bold">{value}</p>
              <p className="text-xs text-stone-500">{label}</p>
            </div>
          ))}
        </div>

        <div className="flex gap-2">
          <a className="btn-outline flex-1" target="_blank" rel="noreferrer" href={whatsappLink(customer.phone)}>
            WhatsApp {formatPhone(customer.phone)}
          </a>
          <button className="btn-primary flex-1" onClick={() => setBooking(true)}>Agendar</button>
        </div>

        <form onSubmit={save} className="space-y-3">
          <div>
            <label className="label" htmlFor="cm-name">Nome</label>
            <input id="cm-name" required minLength={2} maxLength={80} className="input" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div>
            <label className="label" htmlFor="cm-notes">Anotação interna</label>
            <textarea id="cm-notes" rows={2} maxLength={500} className="input" placeholder="Preferências, lembretes de atendimento"
              value={notes} onChange={(e) => setNotes(e.target.value)} />
            <p className="mt-1 text-xs text-stone-500">
              Só você vê. Não registre informações de saúde, diagnósticos ou procedimentos aqui: este sistema guarda só agenda e contato.
            </p>
          </div>
          {message && <p role={message.ok ? "status" : "alert"} className={`text-sm ${message.ok ? "text-green-700" : "text-red-700"}`}>{message.text}</p>}
          <div className="flex items-center justify-between gap-2">
            <button type="button" className="text-sm font-semibold text-red-700" disabled={busy} onClick={remove}>
              Apagar cliente e histórico
            </button>
            <button className="btn-outline" disabled={busy}>Salvar</button>
          </div>
        </form>

        <section>
          <h3 className="mb-1 font-semibold">Histórico</h3>
          {history === null ? (
            <p className="text-sm text-stone-500">Carregando...</p>
          ) : history.length === 0 ? (
            <p className="text-sm text-stone-500">Sem agendamentos.</p>
          ) : (
            <ul className="divide-y divide-stone-100 text-sm">
              {history.map((item) => (
                <li key={item.id} className="flex flex-wrap items-center gap-x-3 py-2">
                  <span className="w-32 text-stone-600">
                    {formatDateFull(dateInSaoPaulo(item.starts_at))} {timeInSaoPaulo(item.starts_at)}
                  </span>
                  <span className="flex-1 font-medium">{item.service_name}</span>
                  <span className={item.status === "no_show" || item.status === "canceled" ? "text-red-700" : "text-stone-600"}>
                    {STATUS_LABEL[item.status]}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </Modal>
  );
}

/** Mensagem de reconquista: a IA escreve; sem IA, usa um texto padrão. O dono revisa e envia do próprio WhatsApp. */
function WinbackModal({ customer, onClose }: { customer: Row; onClose: () => void }) {
  const { business } = useBusiness();
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(true);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    const link = `${window.location.origin}/${business.slug}`;
    const first = customer.name.split(" ")[0];
    const fallback =
      `Oi, ${first}! Aqui é de ${business.name}. Faz um tempo que você não aparece e ficamos com saudade. ` +
      `Quando quiser marcar${customer.favorite_service ? ` seu ${customer.favorite_service.toLowerCase()}` : " um horário"}, é só escolher por aqui: ${link}`;
    fetch("/api/ai/winback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: customer.name,
        favorite: customer.favorite_service ?? "",
        visits: customer.completed,
        daysAway: customer.daysAway ?? 0,
      }),
    })
      .then(async (response) => ({ ok: response.ok, body: await response.json().catch(() => ({})) }))
      .then(({ ok, body }) => {
        if (!active) return;
        if (ok && body.message) return setMessage(body.message);
        setMessage(fallback);
        setNote(body.error ? `${body.error} Usamos um texto padrão; ajuste como quiser.` : "Usamos um texto padrão; ajuste como quiser.");
      })
      .catch(() => {
        if (!active) return;
        setMessage(fallback);
        setNote("Usamos um texto padrão; ajuste como quiser.");
      })
      .finally(() => active && setBusy(false));
    return () => {
      active = false;
    };
  }, [customer, business]);

  return (
    <Modal title={`Mensagem para ${customer.name}`} onClose={onClose}>
      <div className="space-y-4">
        {busy ? (
          <p className="animate-pulse text-sm text-stone-500">Escrevendo a mensagem...</p>
        ) : (
          <>
            <p className="text-sm text-stone-600">
              Revise e ajuste se quiser. Ao continuar, o seu WhatsApp abre com a mensagem pronta para você enviar.
            </p>
            {note && <p className="text-xs text-stone-500">{note}</p>}
            <textarea rows={6} className="input" aria-label="Mensagem" value={message} onChange={(e) => setMessage(e.target.value)} />
            <div className="flex justify-end gap-2">
              <button className="btn-ghost" onClick={onClose}>Cancelar</button>
              <a className={`btn-primary ${message.trim() ? "" : "pointer-events-none opacity-50"}`} target="_blank" rel="noreferrer"
                href={whatsappLink(customer.phone, message)}>
                Abrir no WhatsApp
              </a>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}
