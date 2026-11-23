import type { SupabaseClient } from "@supabase/supabase-js";
import type { Business, Catalog, Professional, Service, WorkingHour } from "./types";

export const BUSINESS_COLUMNS =
  "id, owner_id, slug, name, segment, description, booking_notice, phone, address, logo_url, primary_color, is_accepting, auto_confirm, choose_professional, slot_step_minutes, min_notice_minutes, max_advance_days, cancel_notice_minutes, ai_enabled, pix_key, charge_on_booking, deposit_type, deposit_value, hold_minutes";

const SERVICE_COLUMNS =
  "id, business_id, name, description, category, duration_minutes, price_cents, price_from, is_active, position";

const byPosition = <T extends { position: number; name: string }>(a: T, b: T) =>
  a.position - b.position || a.name.localeCompare(b.name, "pt-BR");

export async function fetchBusinessBySlug(supabase: SupabaseClient, slug: string) {
  const { data } = await supabase.from("businesses").select(BUSINESS_COLUMNS).eq("slug", slug).maybeSingle();
  return data as Business | null;
}

export async function fetchBusinessByOwner(supabase: SupabaseClient, ownerId: string) {
  const { data } = await supabase.from("businesses").select(BUSINESS_COLUMNS).eq("owner_id", ownerId).maybeSingle();
  return data as Business | null;
}

export async function fetchServices(supabase: SupabaseClient, businessId: string) {
  const { data, error } = await supabase.from("services").select(SERVICE_COLUMNS).eq("business_id", businessId);
  if (error) throw new Error(error.message);
  return ((data ?? []) as Service[]).sort(byPosition);
}

export async function fetchProfessionals(supabase: SupabaseClient, businessId: string) {
  const { data, error } = await supabase
    .from("professionals")
    .select("id, business_id, name, role, is_active, custom_hours, position, professional_services(service_id)")
    .eq("business_id", businessId);
  if (error) throw new Error(error.message);
  type Row = Omit<Professional, "service_ids"> & { professional_services: { service_id: string }[] };
  return ((data ?? []) as unknown as Row[])
    .map(({ professional_services, ...professional }) => ({
      ...professional,
      service_ids: professional_services.map((link) => link.service_id),
    }))
    .sort(byPosition);
}

export async function fetchHours(supabase: SupabaseClient, businessId: string) {
  const { data, error } = await supabase
    .from("working_hours")
    .select("id, professional_id, weekday, start_time, end_time")
    .eq("business_id", businessId)
    .order("weekday")
    .order("start_time");
  if (error) throw new Error(error.message);
  return (data ?? []) as WorkingHour[];
}

/** Serviços, profissionais e expediente do estabelecimento, em ordem estável. */
export async function fetchCatalog(supabase: SupabaseClient, business: Business): Promise<Catalog> {
  const [services, professionals, hours] = await Promise.all([
    fetchServices(supabase, business.id),
    fetchProfessionals(supabase, business.id),
    fetchHours(supabase, business.id),
  ]);
  return { business, services, professionals, hours };
}

/**
 * O que o cliente pode agendar: serviços ativos que algum profissional ativo faz, e os
 * profissionais ativos que fazem pelo menos um deles.
 */
export function bookableCatalog(catalog: Catalog): Catalog {
  const professionals = catalog.professionals.filter((p) => p.is_active);
  const offered = new Set(professionals.flatMap((p) => p.service_ids));
  const services = catalog.services.filter((s) => s.is_active && offered.has(s.id));
  const active = new Set(services.map((s) => s.id));
  return {
    ...catalog,
    services,
    professionals: professionals
      .map((p) => ({ ...p, service_ids: p.service_ids.filter((id) => active.has(id)) }))
      .filter((p) => p.service_ids.length > 0),
  };
}

/** Expediente que vale para um profissional: o próprio, se ele tem horário próprio; senão, o da casa. */
export function hoursFor(hours: WorkingHour[], professional: Pick<Professional, "id" | "custom_hours"> | null) {
  return hours.filter((h) =>
    professional?.custom_hours ? h.professional_id === professional.id : h.professional_id === null,
  );
}
