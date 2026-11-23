-- Checkout de pagamento: pronto no banco e DESLIGADO por padrão (businesses.charge_on_booking = false).
--
-- Com o interruptor desligado nada muda no fluxo do cliente e nenhuma chamada ao provedor acontece:
-- o que existe é o Pix "copia e cola" gerado a partir da chave do estabelecimento, com confirmação
-- manual do dono.
--
-- Com o interruptor ligado (só é possível depois de cadastrar as credenciais do provedor):
--   1. o agendamento do cliente nasce "aguardando pagamento", com o horário reservado por alguns minutos;
--   2. o servidor do app cria a cobrança no provedor e confirma o pagamento consultando a API do
--      provedor (nunca confiando no corpo do webhook);
--   3. pago, o agendamento segue o fluxo normal; não pago no prazo, a reserva cai e o horário é liberado;
--   4. cancelado dentro da regra, o pagamento entra em "estorno pendente" e o servidor estorna.
--
-- Credenciais: são do estabelecimento, chegam aqui já cifradas pelo servidor do app (AES-256-GCM,
-- chave só no servidor) e nenhuma função as devolve para o navegador. As funções "server_*" só
-- respondem a quem apresenta a chave de acesso do estabelecimento, da qual o banco guarda só o hash.

-- ---------------------------------------------------------------------------
-- Colunas
-- ---------------------------------------------------------------------------

alter table public.businesses
  add column pix_key text check (char_length(pix_key) <= 140),
  add column charge_on_booking boolean not null default false,
  -- Sinal: percentual do preço, valor fixo em centavos ou o valor total.
  add column deposit_type text not null default 'percent' check (deposit_type in ('percent', 'fixed', 'full')),
  add column deposit_value integer not null default 30 check (deposit_value between 1 and 100000000),
  add column hold_minutes integer not null default 15 check (hold_minutes between 5 and 120),
  add constraint businesses_deposit_percent check (deposit_type <> 'percent' or deposit_value <= 100);

-- O interruptor não entra aqui: só liga por set_charge_on_booking, que exige credenciais.
grant update (pix_key, deposit_type, deposit_value, hold_minutes) on public.businesses to authenticated;

-- A chave Pix costuma ser CPF, celular ou e-mail do dono: não entra na leitura pública da tabela.
-- O cliente a recebe só dentro do próprio agendamento (get_appointment) e o dono, por
-- payment_credentials_status. O público sabe apenas se existe (has_pix). O identificador do dono
-- também sai da leitura anônima.
alter table public.businesses add column has_pix boolean generated always as (pix_key is not null) stored;
revoke select on public.businesses from anon, authenticated;
grant select (
  id, slug, name, segment, description, booking_notice, phone, address, logo_url, primary_color,
  is_accepting, auto_confirm, choose_professional, slot_step_minutes, min_notice_minutes,
  max_advance_days, cancel_notice_minutes, ai_enabled, created_at, charge_on_booking, deposit_type,
  deposit_value, hold_minutes, has_pix
) on public.businesses to anon, authenticated;
grant select (owner_id) on public.businesses to authenticated;

-- Prova de que quem cadastra credencial é o servidor do app, e não o dono chamando o banco direto
-- (o que o deixaria escolher a própria chave de acesso). Guarda só o hash; a linha é semeada uma
-- vez por instalação, quando a cobrança online for habilitada (ver README, "Pagamentos").
create table public.server_keys (
  purpose text primary key check (purpose in ('payments')),
  key_hash text not null check (key_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now()
);
alter table public.server_keys enable row level security;
revoke all on public.server_keys from anon, authenticated;

alter table public.appointments
  add column deposit_cents integer not null default 0 check (deposit_cents >= 0),
  add column payment_status text not null default 'none'
    check (payment_status in ('none', 'awaiting', 'paid', 'manual_paid', 'refund_pending', 'refunded')),
  add column hold_expires_at timestamptz;

create table public.payment_credentials (
  business_id uuid primary key references public.businesses (id) on delete cascade,
  provider text not null check (provider in ('mercadopago')),
  -- Credencial cifrada pelo servidor do app. O banco nunca vê o texto original.
  ciphertext text not null check (char_length(ciphertext) between 20 and 4000),
  -- Últimos caracteres, só para o dono reconhecer qual credencial está cadastrada.
  key_hint text not null check (char_length(key_hint) <= 8),
  -- Hash da chave de acesso que o servidor do app deriva para este estabelecimento.
  access_hash text not null check (access_hash ~ '^[0-9a-f]{64}$'),
  updated_at timestamptz not null default now()
);

create table public.payments (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete cascade,
  appointment_id uuid not null references public.appointments (id) on delete cascade,
  provider text not null check (provider in ('mercadopago')),
  amount_cents integer not null check (amount_cents > 0),
  status text not null default 'pending'
    check (status in ('pending', 'paid', 'expired', 'canceled', 'refund_pending', 'refunded')),
  provider_payment_id text,
  pix_code text,
  ticket_url text,
  expires_at timestamptz not null,
  paid_at timestamptz,
  refund_id text,
  refunded_at timestamptz,
  refund_attempts integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- O identificador é único dentro da conta do provedor, e cada estabelecimento tem a sua.
  unique (business_id, provider, provider_payment_id)
);
-- Idempotência: no máximo uma cobrança viva por agendamento.
create unique index payments_one_live_idx on public.payments (appointment_id)
  where status in ('pending', 'paid', 'refund_pending');
create index payments_business_idx on public.payments (business_id, status);

create trigger payments_touch_updated_at
before update on public.payments
for each row execute function public.touch_updated_at();

alter table public.payment_credentials enable row level security;
alter table public.payments enable row level security;
revoke all on public.payment_credentials, public.payments from anon, authenticated;
-- O dono vê os pagamentos do próprio estabelecimento (nunca as credenciais).
grant select on public.payments to authenticated;
create policy "owner reads payments" on public.payments for select to authenticated
  using (public.is_business_owner(business_id));

-- ---------------------------------------------------------------------------
-- Valor do sinal e reserva com prazo
-- ---------------------------------------------------------------------------

create function public.deposit_for(p_type text, p_value integer, p_price_cents integer)
returns integer
language sql
immutable
set search_path = ''
as $$
  select case p_type
    when 'full' then p_price_cents
    when 'fixed' then least(p_value, p_price_cents)
    else (p_price_cents::bigint * p_value / 100)::integer
  end;
$$;

-- Todo agendamento guarda o valor do sinal que valia quando foi feito. Com a cobrança ligada, o
-- agendamento feito pelo cliente (site ou IA) nasce aguardando pagamento, com prazo.
create function public.appointments_payment_defaults()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_business public.businesses%rowtype;
begin
  select * into v_business from public.businesses where id = new.business_id;
  new.deposit_cents := public.deposit_for(v_business.deposit_type, v_business.deposit_value, new.price_cents);
  if v_business.charge_on_booking and new.source in ('web', 'ai') and new.deposit_cents > 0 then
    new.payment_status := 'awaiting';
    new.status := 'pending';
    new.hold_expires_at := now() + make_interval(mins => v_business.hold_minutes);
  end if;
  return new;
end;
$$;

create trigger appointments_payment_defaults
before insert on public.appointments
for each row execute function public.appointments_payment_defaults();

-- Enquanto o sinal não é pago, o agendamento não confirma por nenhum caminho (remarcar, por exemplo)
-- e, vencido o prazo, não pode mais ser remarcado: só pago, liberado pelo dono ou cancelado.
create function public.appointments_guard_unpaid()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.payment_status = 'awaiting' and new.payment_status = 'awaiting' and new.status <> 'canceled' then
    if old.hold_expires_at < now()
       and (new.starts_at <> old.starts_at or new.professional_id <> old.professional_id) then
      raise exception 'O prazo para pagar terminou e o horário foi liberado. Agende de novo.' using errcode = 'AG409';
    end if;
    new.status := 'pending';
  end if;
  return new;
end;
$$;

create trigger appointments_guard_unpaid
before update on public.appointments
for each row execute function public.appointments_guard_unpaid();

-- Reserva vencida: cancela e libera o horário. Roda antes de qualquer agendamento ou remarcação
-- que queira aquele profissional naquele intervalo, então a reserva vencida nunca bloqueia ninguém.
create function public.appointments_release_expired_holds()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.status in ('pending', 'confirmed', 'completed') then
    update public.appointments a
       set status = 'canceled', canceled_by = 'business', canceled_at = now(),
           cancel_reason = 'Pagamento não realizado no prazo'
     where a.professional_id = new.professional_id
       and a.id <> new.id
       and a.status = 'pending'
       and a.payment_status = 'awaiting'
       and a.hold_expires_at < now()
       and a.starts_at < new.ends_at and a.ends_at > new.starts_at;
  end if;
  return new;
end;
$$;

create trigger appointments_release_expired_holds
before insert or update of starts_at, ends_at, professional_id, status on public.appointments
for each row execute function public.appointments_release_expired_holds();

-- Cancelamento reflete no pagamento: cobrança em aberto é encerrada; sinal pago entra em estorno
-- pendente (o servidor do app faz o estorno no provedor e registra o resultado).
create function public.appointments_cancel_payment()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.status = 'canceled' and old.status <> 'canceled' then
    update public.payments
       set status = case when new.canceled_at is not null and new.cancel_reason = 'Pagamento não realizado no prazo'
                         then 'expired' else 'canceled' end
     where appointment_id = new.id and status = 'pending';
    if old.payment_status = 'paid' then
      update public.payments set status = 'refund_pending' where appointment_id = new.id and status = 'paid';
      new.payment_status := 'refund_pending';
    elsif old.payment_status = 'awaiting' then
      new.payment_status := 'none';
    end if;
    new.hold_expires_at := null;
  end if;
  return new;
end;
$$;

create trigger appointments_cancel_payment
before update of status on public.appointments
for each row execute function public.appointments_cancel_payment();

-- Horário livre: igual à versão anterior, com uma diferença. Reserva aguardando pagamento que já
-- venceu não ocupa o horário.
create or replace function public.slot_candidates(
  p_business_id uuid,
  p_service_id uuid,
  p_professional_id uuid,
  p_from date,
  p_to date,
  p_ignore_appointment uuid,
  p_public_rules boolean
)
returns table (professional_id uuid, starts_at timestamptz, ends_at timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
  with b as (
    select * from public.businesses where id = p_business_id
  ),
  s as (
    select * from public.services where id = p_service_id and business_id = p_business_id
  ),
  pros as (
    select p.id, p.custom_hours
    from public.professionals p
    join public.professional_services ps on ps.professional_id = p.id and ps.service_id = p_service_id
    where p.business_id = p_business_id
      and p.is_active
      and (p_professional_id is null or p.id = p_professional_id)
  ),
  days as (
    select d::date as day from generate_series(p_from::timestamp, p_to::timestamp, interval '1 day') as d
  ),
  periods as (
    select pr.id as professional_id, dy.day, wh.start_time, wh.end_time,
           (extract(epoch from (wh.end_time - wh.start_time)) / 60)::integer as minutes
    from pros pr
    cross join days dy
    join public.working_hours wh
      on wh.business_id = p_business_id
     and wh.weekday = extract(dow from dy.day)::integer
     and case when pr.custom_hours then wh.professional_id = pr.id else wh.professional_id is null end
  ),
  candidates as (
    select distinct pe.professional_id,
           (pe.day + pe.start_time) + make_interval(mins => n * b.slot_step_minutes) as local_start
    from periods pe
    cross join b
    cross join s
    cross join lateral generate_series(0, (pe.minutes - s.duration_minutes) / b.slot_step_minutes) as n
    where pe.minutes >= s.duration_minutes
  ),
  slots as (
    select c.professional_id,
           c.local_start at time zone public.tz() as starts_at,
           (c.local_start at time zone public.tz()) + make_interval(mins => s.duration_minutes) as ends_at
    from candidates c
    cross join s
  )
  select sl.professional_id, sl.starts_at, sl.ends_at
  from slots sl
  cross join b
  where (
      not p_public_rules
      or (
        sl.starts_at >= now() + make_interval(mins => b.min_notice_minutes)
        and sl.starts_at < public.local_ts(public.local_today() + b.max_advance_days + 1, '00:00')
      )
    )
    and not exists (
      select 1 from public.blocks k
      where k.business_id = p_business_id
        and (k.professional_id is null or k.professional_id = sl.professional_id)
        and k.starts_at < sl.ends_at and k.ends_at > sl.starts_at
    )
    and not exists (
      select 1 from public.appointments a
      where a.professional_id = sl.professional_id
        and a.status in ('pending', 'confirmed', 'completed')
        and not (a.status = 'pending' and a.payment_status = 'awaiting' and a.hold_expires_at < now())
        and a.id is distinct from p_ignore_appointment
        and a.starts_at < sl.ends_at and a.ends_at > sl.starts_at
    );
$$;

-- ---------------------------------------------------------------------------
-- Visão do cliente e do dono, agora com o pagamento
-- ---------------------------------------------------------------------------

create or replace function public.get_appointment(p_token uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'status', a.status,
    'service_id', a.service_id,
    'service_name', a.service_name,
    'duration_minutes', a.duration_minutes,
    'price_cents', a.price_cents,
    'professional_id', a.professional_id,
    'professional_name', pr.name,
    'customer_name', a.customer_name,
    'starts_at', a.starts_at,
    'ends_at', a.ends_at,
    'date', (a.starts_at at time zone public.tz())::date,
    'time', to_char(a.starts_at at time zone public.tz(), 'HH24:MI'),
    'end_time', to_char(a.ends_at at time zone public.tz(), 'HH24:MI'),
    'notes', a.notes,
    'cancel_reason', a.cancel_reason,
    'canceled_by', a.canceled_by,
    'source', a.source,
    'can_change', a.status in ('pending', 'confirmed')
      and now() <= a.starts_at - make_interval(mins => b.cancel_notice_minutes),
    'change_deadline', a.starts_at - make_interval(mins => b.cancel_notice_minutes),
    'is_past', a.starts_at <= now(),
    'deposit_cents', a.deposit_cents,
    'payment_status', a.payment_status,
    'hold_expires_at', a.hold_expires_at,
    'hold_expired', a.payment_status = 'awaiting' and a.hold_expires_at < now(),
    -- Cobrança em aberto no provedor (o código Pix é do próprio cliente; não há credencial aqui).
    'payment', (
      select jsonb_build_object(
        'status', p.status, 'amount_cents', p.amount_cents, 'pix_code', p.pix_code,
        'ticket_url', p.ticket_url, 'expires_at', p.expires_at
      )
      from public.payments p
      where p.appointment_id = a.id
      order by p.created_at desc
      limit 1
    ),
    'business', jsonb_build_object(
      'id', b.id, 'slug', b.slug, 'name', b.name, 'phone', b.phone, 'address', b.address,
      'logo_url', b.logo_url, 'primary_color', b.primary_color, 'booking_notice', b.booking_notice,
      'cancel_notice_minutes', b.cancel_notice_minutes, 'choose_professional', b.choose_professional,
      'pix_key', b.pix_key, 'charge_on_booking', b.charge_on_booking
    )
  )
  from public.appointments a
  join public.businesses b on b.id = a.business_id
  join public.professionals pr on pr.id = a.professional_id
  where a.public_token = p_token;
$$;

create or replace function public.appointment_json(a public.appointments)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'id', a.id,
    'public_token', a.public_token,
    'service_id', a.service_id,
    'service_name', a.service_name,
    'duration_minutes', a.duration_minutes,
    'price_cents', a.price_cents,
    'professional_id', a.professional_id,
    'customer_id', a.customer_id,
    'customer_name', a.customer_name,
    'customer_phone', (select c.phone from public.customers c where c.id = a.customer_id),
    'starts_at', a.starts_at,
    'ends_at', a.ends_at,
    'date', (a.starts_at at time zone public.tz())::date,
    'time', to_char(a.starts_at at time zone public.tz(), 'HH24:MI'),
    'end_time', to_char(a.ends_at at time zone public.tz(), 'HH24:MI'),
    'status', a.status,
    'source', a.source,
    'notes', a.notes,
    'cancel_reason', a.cancel_reason,
    'canceled_by', a.canceled_by,
    'is_past', a.starts_at <= now(),
    'created_at', a.created_at,
    'deposit_cents', a.deposit_cents,
    'payment_status', a.payment_status,
    'hold_expires_at', a.hold_expires_at
  );
$$;

-- Reserva vencida some assim que alguém olha para ela (página do cliente). Só cancela o que venceu.
create function public.release_hold(p_token uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  update public.appointments
     set status = 'canceled', canceled_by = 'business', canceled_at = now(),
         cancel_reason = 'Pagamento não realizado no prazo'
   where public_token = p_token and status = 'pending'
     and payment_status = 'awaiting' and hold_expires_at < now();
  get diagnostics v_count = row_count;
  return v_count > 0;
end;
$$;

-- ---------------------------------------------------------------------------
-- Dono: configuração da cobrança e confirmação manual
-- ---------------------------------------------------------------------------

-- Guarda a credencial já cifrada pelo servidor do app. Só o dono logado consegue chamar.
create function public.set_payment_credentials(
  p_business_id uuid, p_provider text, p_ciphertext text, p_key_hint text, p_access_hash text, p_server_proof text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.require_owner(p_business_id);
  -- Só o servidor do app sabe a prova. Sem ela, o dono poderia gravar uma chave de acesso escolhida
  -- por ele e passar a falar com as funções server_* em nome do próprio estabelecimento.
  if p_server_proof is null or not exists (
    select 1 from public.server_keys k
    where k.purpose = 'payments' and k.key_hash = encode(sha256(convert_to(p_server_proof, 'utf8')), 'hex')
  ) then
    raise exception 'A cobrança online ainda não foi habilitada nesta instalação.' using errcode = 'AG403';
  end if;
  insert into public.payment_credentials (business_id, provider, ciphertext, key_hint, access_hash)
  values (p_business_id, p_provider, p_ciphertext, left(p_key_hint, 8), p_access_hash)
  on conflict (business_id) do update
    set provider = excluded.provider, ciphertext = excluded.ciphertext, key_hint = excluded.key_hint,
        access_hash = excluded.access_hash, updated_at = now();
end;
$$;

-- Remover a credencial desliga a cobrança.
create function public.delete_payment_credentials(p_business_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.require_owner(p_business_id);
  update public.businesses set charge_on_booking = false where id = p_business_id;
  delete from public.payment_credentials where business_id = p_business_id;
end;
$$;

-- O que o dono vê sobre a credencial: se existe, de qual provedor e os últimos caracteres.
create function public.payment_credentials_status(p_business_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform public.require_owner(p_business_id);
  return coalesce(
    (select jsonb_build_object('connected', true, 'provider', c.provider, 'key_hint', c.key_hint, 'updated_at', c.updated_at)
       from public.payment_credentials c where c.business_id = p_business_id),
    jsonb_build_object('connected', false))
    || jsonb_build_object('pix_key', (select b.pix_key from public.businesses b where b.id = p_business_id));
end;
$$;

-- O interruptor "cobrar no agendamento". Só liga com credencial cadastrada.
create function public.set_charge_on_booking(p_business_id uuid, p_on boolean)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.require_owner(p_business_id);
  if p_on and not exists (select 1 from public.payment_credentials where business_id = p_business_id) then
    raise exception 'Cadastre as credenciais do provedor de pagamento antes de ligar a cobrança.' using errcode = 'AG409';
  end if;
  update public.businesses set charge_on_booking = coalesce(p_on, false) where id = p_business_id;
  return coalesce(p_on, false);
end;
$$;

-- Confirmação manual do Pix copia e cola (cobrança desligada): o dono marca que recebeu, ou desfaz.
create function public.owner_mark_paid(p_appointment_id uuid, p_paid boolean)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_appointment public.appointments%rowtype;
begin
  select a.* into v_appointment from public.appointments a where a.id = p_appointment_id for update;
  if not found then
    raise exception 'Agendamento não encontrado.' using errcode = 'AG404';
  end if;
  perform public.require_owner(v_appointment.business_id);
  if v_appointment.payment_status = 'awaiting' and p_paid and v_appointment.status = 'pending' then
    -- O dono recebeu por fora (dinheiro, Pix direto): encerra a cobrança em aberto e confirma.
    update public.payments set status = 'canceled' where appointment_id = v_appointment.id and status = 'pending';
    update public.appointments
       set payment_status = 'manual_paid', hold_expires_at = null, status = 'confirmed'
     where id = v_appointment.id
    returning * into v_appointment;
    return public.appointment_json(v_appointment);
  end if;
  if v_appointment.payment_status not in ('none', 'manual_paid') then
    raise exception 'Este agendamento tem pagamento pelo provedor: a situação muda sozinha.' using errcode = 'AG409';
  end if;
  update public.appointments
     set payment_status = case when p_paid then 'manual_paid' else 'none' end
   where id = v_appointment.id
  returning * into v_appointment;
  return public.appointment_json(v_appointment);
end;
$$;

-- ---------------------------------------------------------------------------
-- Cliente: começar o pagamento do próprio agendamento (pelo link secreto)
-- ---------------------------------------------------------------------------

-- Cria (ou devolve) a cobrança viva do agendamento. Não fala com o provedor: quem fala é o servidor do app.
create function public.payment_begin(p_token uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_appointment public.appointments%rowtype;
  v_business public.businesses%rowtype;
  v_provider text;
  v_payment public.payments%rowtype;
begin
  select a.* into v_appointment from public.appointments a where a.public_token = p_token for update;
  if not found then
    raise exception 'Agendamento não encontrado.' using errcode = 'AG404';
  end if;
  if v_appointment.status <> 'pending' or v_appointment.payment_status <> 'awaiting' then
    raise exception 'Este agendamento não está aguardando pagamento.' using errcode = 'AG409';
  end if;
  if v_appointment.hold_expires_at < now() then
    raise exception 'O prazo para pagar terminou e o horário foi liberado. Agende de novo.' using errcode = 'AG409';
  end if;
  select * into v_business from public.businesses where id = v_appointment.business_id;
  select c.provider into v_provider from public.payment_credentials c where c.business_id = v_business.id;
  if not v_business.charge_on_booking or v_provider is null then
    raise exception 'A cobrança online não está ativa neste estabelecimento.' using errcode = 'AG409';
  end if;

  select * into v_payment from public.payments
  where appointment_id = v_appointment.id and status = 'pending';
  if not found then
    insert into public.payments (business_id, appointment_id, provider, amount_cents, expires_at)
    values (v_business.id, v_appointment.id, v_provider, v_appointment.deposit_cents, v_appointment.hold_expires_at)
    returning * into v_payment;
  end if;

  return jsonb_build_object(
    'business_id', v_business.id,
    'business_name', v_business.name,
    'slug', v_business.slug,
    'payment_id', v_payment.id,
    'provider', v_payment.provider,
    'amount_cents', v_payment.amount_cents,
    'expires_at', v_payment.expires_at,
    'provider_payment_id', v_payment.provider_payment_id,
    'pix_code', v_payment.pix_code,
    'ticket_url', v_payment.ticket_url,
    'description', v_appointment.service_name,
    'customer_name', v_appointment.customer_name
  );
end;
$$;

-- Cobranças do agendamento que o servidor ainda precisa conferir ou estornar.
create function public.payment_lookup(p_token uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'business_id', a.business_id,
    'payments', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', p.id, 'status', p.status, 'provider', p.provider,
        'provider_payment_id', p.provider_payment_id, 'amount_cents', p.amount_cents))
      from public.payments p
      where p.appointment_id = a.id and p.provider_payment_id is not null
        and (p.status in ('pending', 'refund_pending')
             or (p.status in ('expired', 'canceled') and p.created_at > now() - interval '3 days'))
    ), '[]'::jsonb)
  )
  from public.appointments a
  where a.public_token = p_token;
$$;

-- ---------------------------------------------------------------------------
-- Servidor do app: só responde a quem apresenta a chave de acesso do estabelecimento
-- ---------------------------------------------------------------------------

create function public.require_server_key(p_business_id uuid, p_access_key text)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if p_access_key is null or not exists (
    select 1 from public.payment_credentials c
    where c.business_id = p_business_id
      and c.access_hash = encode(sha256(convert_to(p_access_key, 'utf8')), 'hex')
  ) then
    raise exception 'Acesso negado.' using errcode = 'AG403';
  end if;
end;
$$;

-- Credencial cifrada, para o servidor decifrar e falar com o provedor.
create function public.server_payment_credentials(p_business_id uuid, p_access_key text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform public.require_server_key(p_business_id, p_access_key);
  return (select jsonb_build_object('provider', c.provider, 'ciphertext', c.ciphertext)
          from public.payment_credentials c where c.business_id = p_business_id);
end;
$$;

-- Grava na cobrança o que o provedor devolveu ao criá-la.
create function public.server_payment_attach(
  p_business_id uuid, p_access_key text, p_payment_id uuid,
  p_provider_payment_id text, p_pix_code text, p_ticket_url text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.require_server_key(p_business_id, p_access_key);
  update public.payments
     set provider_payment_id = p_provider_payment_id, pix_code = p_pix_code, ticket_url = p_ticket_url
   where id = p_payment_id and business_id = p_business_id and status = 'pending';
end;
$$;

-- Resultado conferido na API do provedor. Idempotente: repetir não muda nada.
-- p_status: 'approved', 'pending' ou 'failed' (recusado, cancelado ou vencido no provedor).
create function public.server_payment_result(
  p_business_id uuid, p_access_key text, p_provider text, p_provider_payment_id text,
  p_status text, p_amount_cents integer
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_payment public.payments%rowtype;
  v_appointment public.appointments%rowtype;
  v_business public.businesses%rowtype;
begin
  perform public.require_server_key(p_business_id, p_access_key);
  select * into v_payment from public.payments
  where business_id = p_business_id and provider = p_provider and provider_payment_id = p_provider_payment_id
  for update;
  if not found then
    return jsonb_build_object('state', 'unknown');
  end if;
  if v_payment.status in ('paid', 'refund_pending', 'refunded') then
    return jsonb_build_object('state', v_payment.status, 'payment_id', v_payment.id);
  end if;
  if p_status = 'pending' then
    return jsonb_build_object('state', v_payment.status, 'payment_id', v_payment.id);
  end if;
  -- Daqui para baixo a cobrança pode estar em aberto, vencida ou encerrada: se o dinheiro chegou
  -- de qualquer jeito (pagamento atrasado), ele precisa ser reconhecido para ser devolvido.
  if p_status <> 'approved' then
    update public.payments set status = 'canceled' where id = v_payment.id and status = 'pending';
    return jsonb_build_object('state', case when v_payment.status = 'pending' then 'canceled' else v_payment.status end, 'payment_id', v_payment.id);
  end if;
  -- Valor pago diferente do cobrado: não confirma nada.
  if p_amount_cents is distinct from v_payment.amount_cents then
    return jsonb_build_object('state', 'amount_mismatch', 'payment_id', v_payment.id);
  end if;

  select a.* into v_appointment from public.appointments a where a.id = v_payment.appointment_id for update;
  select * into v_business from public.businesses where id = p_business_id;

  if v_appointment.status = 'pending' and v_appointment.payment_status = 'awaiting' then
    -- Pago dentro da reserva (ou depois do prazo, mas antes de alguém levar o horário).
    update public.payments set status = 'paid', paid_at = now() where id = v_payment.id;
    update public.appointments
       set payment_status = 'paid', hold_expires_at = null,
           status = case when v_business.auto_confirm then 'confirmed' else 'pending' end
     where id = v_appointment.id;
    return jsonb_build_object('state', 'paid', 'payment_id', v_payment.id);
  end if;

  -- O dinheiro chegou, mas o agendamento já tinha caído ou sido cancelado: devolve.
  update public.payments set status = 'refund_pending', paid_at = now() where id = v_payment.id;
  update public.appointments set payment_status = 'refund_pending' where id = v_appointment.id;
  return jsonb_build_object('state', 'refund_pending', 'payment_id', v_payment.id);
end;
$$;

-- Estornos que o servidor ainda precisa fazer no provedor.
create function public.server_pending_refunds(p_business_id uuid, p_access_key text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.require_server_key(p_business_id, p_access_key);
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', p.id, 'provider', p.provider, 'provider_payment_id', p.provider_payment_id, 'amount_cents', p.amount_cents))
    from public.payments p
    where p.business_id = p_business_id and p.status = 'refund_pending' and p.provider_payment_id is not null
      and p.refund_attempts < 20
  ), '[]'::jsonb);
end;
$$;

-- Resultado do estorno no provedor.
create function public.server_refund_result(
  p_business_id uuid, p_access_key text, p_payment_id uuid, p_ok boolean, p_refund_id text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_appointment_id uuid;
begin
  perform public.require_server_key(p_business_id, p_access_key);
  if p_ok then
    update public.payments
       set status = 'refunded', refunded_at = now(), refund_id = p_refund_id, refund_attempts = refund_attempts + 1
     where id = p_payment_id and business_id = p_business_id and status = 'refund_pending'
    returning appointment_id into v_appointment_id;
    update public.appointments set payment_status = 'refunded' where id = v_appointment_id;
  else
    update public.payments set refund_attempts = refund_attempts + 1
     where id = p_payment_id and business_id = p_business_id and status = 'refund_pending';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- Privilégios: nada público por padrão; lista explícita
-- ---------------------------------------------------------------------------

revoke execute on function
  public.deposit_for(text, integer, integer),
  public.appointments_payment_defaults(),
  public.appointments_release_expired_holds(),
  public.appointments_guard_unpaid(),
  public.appointments_cancel_payment(),
  public.release_hold(uuid),
  public.set_payment_credentials(uuid, text, text, text, text, text),
  public.delete_payment_credentials(uuid),
  public.payment_credentials_status(uuid),
  public.set_charge_on_booking(uuid, boolean),
  public.owner_mark_paid(uuid, boolean),
  public.payment_begin(uuid),
  public.payment_lookup(uuid),
  public.require_server_key(uuid, text),
  public.server_payment_credentials(uuid, text),
  public.server_payment_attach(uuid, text, uuid, text, text, text),
  public.server_payment_result(uuid, text, text, text, text, integer),
  public.server_pending_refunds(uuid, text),
  public.server_refund_result(uuid, text, uuid, boolean, text)
from public, anon, authenticated;

-- Cliente (pelo link secreto) e servidor do app (que usa a chave pública e prova quem é pela chave de acesso).
grant execute on function
  public.release_hold(uuid),
  public.payment_begin(uuid),
  public.payment_lookup(uuid),
  public.server_payment_credentials(uuid, text),
  public.server_payment_attach(uuid, text, uuid, text, text, text),
  public.server_payment_result(uuid, text, text, text, text, integer),
  public.server_pending_refunds(uuid, text),
  public.server_refund_result(uuid, text, uuid, boolean, text)
to anon, authenticated;

grant execute on function
  public.set_payment_credentials(uuid, text, text, text, text, text),
  public.delete_payment_credentials(uuid),
  public.payment_credentials_status(uuid),
  public.set_charge_on_booking(uuid, boolean),
  public.owner_mark_paid(uuid, boolean)
to authenticated;
