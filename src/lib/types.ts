export type Segment = "clinica" | "estetica" | "salao" | "bronze";

export type Business = {
  id: string;
  slug: string;
  name: string;
  segment: Segment;
  description: string | null;
  booking_notice: string | null;
  phone: string | null;
  address: string | null;
  logo_url: string | null;
  primary_color: string;
  is_accepting: boolean;
  auto_confirm: boolean;
  choose_professional: boolean;
  slot_step_minutes: number;
  min_notice_minutes: number;
  max_advance_days: number;
  cancel_notice_minutes: number;
  ai_enabled: boolean;
  /** O estabelecimento tem chave Pix para o "copia e cola" com confirmação manual. A chave em si não é pública. */
  has_pix: boolean;
  /** Cobrança do sinal pelo provedor. Desligada por padrão. */
  charge_on_booking: boolean;
  deposit_type: "percent" | "fixed" | "full";
  deposit_value: number;
  hold_minutes: number;
};

export type PaymentStatus = "none" | "awaiting" | "paid" | "manual_paid" | "refund_pending" | "refunded";

export type Service = {
  id: string;
  business_id: string;
  name: string;
  description: string | null;
  category: string | null;
  duration_minutes: number;
  price_cents: number;
  price_from: boolean;
  is_active: boolean;
  position: number;
};

export type Professional = {
  id: string;
  business_id: string;
  name: string;
  role: string | null;
  is_active: boolean;
  custom_hours: boolean;
  position: number;
  /** Serviços que este profissional faz. */
  service_ids: string[];
};

/** Um período do expediente. professional_id nulo = expediente do estabelecimento. */
export type WorkingHour = {
  id: string;
  professional_id: string | null;
  weekday: number;
  start_time: string;
  end_time: string;
};

/** Tudo que a página pública e o painel precisam para montar a agenda. */
export type Catalog = {
  business: Business;
  services: Service[];
  professionals: Professional[];
  hours: WorkingHour[];
};

export type AppointmentStatus = "pending" | "confirmed" | "completed" | "no_show" | "canceled";
export type AppointmentSource = "web" | "ai" | "panel";

/** Horário livre: "at" é o instante (enviado de volta ao agendar) e "time" a hora de São Paulo. */
export type Slot = { at: string; time: string };
export type AvailabilityDay = { date: string; slots: Slot[] };

/** Retorno de get_availability. Dias sem horário livre não aparecem em "days". */
export type Availability = {
  today: string;
  from: string;
  to: string;
  last_date: string;
  accepting: boolean;
  days: AvailabilityDay[];
};

/** Retorno de book_appointment. */
export type BookedAppointment = {
  token: string;
  status: AppointmentStatus;
  starts_at: string;
  date: string;
  time: string;
  service_name: string;
  price_cents: number;
  professional_name: string;
};

/** Retorno de get_appointment (visão do cliente, pelo link secreto). */
export type PublicAppointment = {
  status: AppointmentStatus;
  service_id: string | null;
  service_name: string;
  duration_minutes: number;
  price_cents: number;
  professional_id: string;
  professional_name: string;
  customer_name: string;
  starts_at: string;
  ends_at: string;
  date: string;
  time: string;
  end_time: string;
  notes: string | null;
  cancel_reason: string | null;
  canceled_by: "customer" | "business" | null;
  source: AppointmentSource;
  can_change: boolean;
  change_deadline: string;
  is_past: boolean;
  deposit_cents: number;
  payment_status: PaymentStatus;
  hold_expires_at: string | null;
  hold_expired: boolean;
  /** Cobrança mais recente no provedor, se houver. */
  payment: { status: string; amount_cents: number; pix_code: string | null; ticket_url: string | null; expires_at: string } | null;
  business: Pick<
    Business,
    | "id"
    | "slug"
    | "name"
    | "phone"
    | "address"
    | "logo_url"
    | "primary_color"
    | "booking_notice"
    | "cancel_notice_minutes"
    | "choose_professional"
    | "charge_on_booking"
  > & {
    /** Só chega aqui, para quem tem o link do agendamento. */
    pix_key: string | null;
  };
};

/** Agendamento na visão do dono (appointment_json). */
export type OwnerAppointment = {
  id: string;
  public_token: string;
  service_id: string | null;
  service_name: string;
  duration_minutes: number;
  price_cents: number;
  professional_id: string;
  customer_id: string;
  customer_name: string;
  customer_phone: string;
  starts_at: string;
  ends_at: string;
  date: string;
  time: string;
  end_time: string;
  status: AppointmentStatus;
  source: AppointmentSource;
  notes: string | null;
  cancel_reason: string | null;
  canceled_by: "customer" | "business" | null;
  is_past: boolean;
  created_at: string;
  deposit_cents: number;
  payment_status: PaymentStatus;
  hold_expires_at: string | null;
};

export type Block = {
  id: string;
  professional_id: string | null;
  reason: string | null;
  starts_at: string;
  ends_at: string;
  start_date: string;
  start_time: string;
  end_date: string;
  end_time: string;
};

/** Retorno de owner_agenda. */
export type Agenda = {
  today: string;
  now_time: string;
  appointments: OwnerAppointment[];
  blocks: Block[];
};

/** Horário livre na visão do dono: por profissional. */
export type OwnerSlot = Slot & { professional_id: string };

/** Linha de owner_customers. */
export type CustomerSummary = {
  id: string;
  name: string;
  phone: string;
  notes: string | null;
  created_at: string;
  completed: number;
  no_shows: number;
  canceled: number;
  upcoming: number;
  last_visit_at: string | null;
  next_at: string | null;
  spent_cents: number;
  favorite_service: string | null;
};
