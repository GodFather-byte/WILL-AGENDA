"use client";

import { useState } from "react";
import { Modal } from "@/components/Modal";
import { errorMessage, groupByCategory } from "@/lib/format";
import { createClient } from "@/lib/supabase/client";
import type { Professional } from "@/lib/types";
import { useBusiness } from "./BusinessContext";
import { HoursEditor } from "./HoursEditor";

export function ProfessionalsManager() {
  const { catalog, reload } = useBusiness();
  const [editing, setEditing] = useState<Professional | "new" | null>(null);

  async function toggle(professional: Professional) {
    await createClient().from("professionals").update({ is_active: !professional.is_active }).eq("id", professional.id);
    await reload();
  }

  return (
    <div className="max-w-3xl space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold">Profissionais</h1>
          <p className="text-sm text-stone-600">Quem atende, quais serviços faz e em que horário.</p>
        </div>
        <button className="btn-primary" onClick={() => setEditing("new")}>+ Novo profissional</button>
      </div>
      <ul className="card divide-y divide-stone-100">
        {catalog.professionals.map((professional) => (
          <li key={professional.id} className={`flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3 text-sm ${professional.is_active ? "" : "opacity-60"}`}>
            <div className="min-w-0 flex-1">
              <p className="font-semibold">
                {professional.name}
                {professional.role && <span className="font-normal text-stone-500"> · {professional.role}</span>}
              </p>
              <p className="text-stone-500">
                {professional.service_ids.length} {professional.service_ids.length === 1 ? "serviço" : "serviços"} ·{" "}
                {professional.custom_hours ? "horário próprio" : "horário da casa"}
                {!professional.is_active && " · inativo"}
              </p>
            </div>
            <button className="btn-ghost py-1.5" onClick={() => toggle(professional)}>{professional.is_active ? "Desativar" : "Reativar"}</button>
            <button className="btn-outline py-1.5" onClick={() => setEditing(professional)}>Editar</button>
          </li>
        ))}
      </ul>
      {editing && <ProfessionalModal professional={editing === "new" ? null : editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

function ProfessionalModal({ professional, onClose }: { professional: Professional | null; onClose: () => void }) {
  const { business, catalog, reload } = useBusiness();
  const [name, setName] = useState(professional?.name ?? "");
  const [role, setRole] = useState(professional?.role ?? "");
  const [serviceIds, setServiceIds] = useState<string[]>(professional?.service_ids ?? catalog.services.map((s) => s.id));
  const [customHours, setCustomHours] = useState(professional?.custom_hours ?? false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const supabase = createClient();
    const patch = { name: name.trim(), role: role.trim() || null, custom_hours: customHours };
    let id = professional?.id;
    if (professional) {
      const { error } = await supabase.from("professionals").update(patch).eq("id", professional.id);
      if (error) {
        setBusy(false);
        return setError("Não foi possível salvar.");
      }
    } else {
      const position = Math.max(0, ...catalog.professionals.map((p) => p.position)) + 1;
      const { data, error } = await supabase
        .from("professionals")
        .insert({ ...patch, business_id: business.id, position })
        .select("id")
        .single();
      if (error || !data) {
        setBusy(false);
        return setError("Não foi possível salvar.");
      }
      id = data.id;
    }
    const { error: linkError } = await supabase.rpc("set_professional_services", { p_professional_id: id, p_service_ids: serviceIds });
    if (linkError) {
      setBusy(false);
      return setError(errorMessage(linkError, "Não foi possível salvar os serviços."));
    }
    await reload();
    onClose();
  }

  async function remove() {
    if (!professional || !window.confirm(`Apagar ${professional.name}?`)) return;
    setBusy(true);
    const { error } = await createClient().from("professionals").delete().eq("id", professional.id);
    if (error) {
      setBusy(false);
      // 23503: há agendamentos ligados a este profissional.
      return setError(
        error.code === "23503"
          ? "Este profissional tem agendamentos no histórico e não pode ser apagado. Use Desativar: ele some da agenda online e o histórico fica."
          : "Não foi possível apagar.",
      );
    }
    await reload();
    onClose();
  }

  return (
    <Modal title={professional ? `Editar ${professional.name}` : "Novo profissional"} onClose={onClose}>
      <form onSubmit={save} className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label className="label" htmlFor="pf-name">Nome</label>
            <input id="pf-name" required maxLength={60} className="input" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div>
            <label className="label" htmlFor="pf-role">Função (opcional)</label>
            <input id="pf-role" maxLength={60} className="input" placeholder="Ex.: Cabeleireira" value={role} onChange={(e) => setRole(e.target.value)} />
          </div>
        </div>
        <fieldset>
          <legend className="label">Serviços que faz</legend>
          <div className="max-h-56 space-y-3 overflow-y-auto rounded-lg border border-stone-200 p-3">
            {catalog.services.length === 0 && <p className="text-sm text-stone-500">Cadastre serviços primeiro.</p>}
            {groupByCategory(catalog.services).map((group) => (
              <div key={group.category ?? ""}>
                {group.category && <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-stone-500">{group.category}</p>}
                {group.items.map((service) => (
                  <label key={service.id} className="flex items-center gap-2 py-0.5 text-sm">
                    <input type="checkbox" checked={serviceIds.includes(service.id)}
                      onChange={(e) =>
                        setServiceIds((ids) => (e.target.checked ? [...ids, service.id] : ids.filter((id) => id !== service.id)))
                      } />
                    {service.name}
                  </label>
                ))}
              </div>
            ))}
          </div>
        </fieldset>
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" className="mt-0.5" checked={customHours} onChange={(e) => setCustomHours(e.target.checked)} />
          <span>
            Tem horário próprio
            <span className="block text-xs text-stone-500">Desmarcado, segue o horário de funcionamento do estabelecimento.</span>
          </span>
        </label>
        {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
        <div className="flex items-center justify-end gap-2">
          {professional && <button type="button" className="btn-danger mr-auto" disabled={busy} onClick={remove}>Apagar</button>}
          <button type="button" className="btn-ghost" onClick={onClose}>Fechar</button>
          <button className="btn-primary" disabled={busy}>{busy ? "Salvando..." : "Salvar"}</button>
        </div>
      </form>
      {professional && customHours && (
        <div className="mt-6 border-t border-stone-200 pt-4">
          <h3 className="font-semibold">Horário de {professional.name}</h3>
          {!professional.custom_hours && (
            <p className="mt-1 text-xs text-amber-700">Salve acima para o horário próprio começar a valer.</p>
          )}
          <HoursEditor professionalId={professional.id} hours={catalog.hours.filter((h) => h.professional_id === professional.id)} />
        </div>
      )}
      {!professional && customHours && (
        <p className="mt-3 text-xs text-stone-500">Salve o profissional e abra de novo para definir o horário dele.</p>
      )}
    </Modal>
  );
}
