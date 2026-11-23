-- Will Agenda: esquema inicial (multi-estabelecimento).
--
-- Regras que valem para o arquivo inteiro:
--   * Dinheiro sempre em centavos (integer).
--   * Instantes guardados em UTC (timestamptz). Tudo que o cliente e o dono veem é convertido
--     para o fuso de São Paulo AQUI, no banco. O navegador nunca converte hora local em UTC.
--   * Visitante anônimo nunca lê nem grava nas tabelas de agenda e de clientes: usa as funções
--     get_availability, book_appointment, get_appointment, reschedule_appointment e cancel_appointment.
--   * Dois agendamentos ativos do mesmo profissional nunca se sobrepõem (appointments_no_overlap).
--   * Sem dado de saúde: só agenda e contato.

create extension if not exists btree_gist with schema extensions;

-- ---------------------------------------------------------------------------
-- Tabelas
-- ---------------------------------------------------------------------------

create table public.businesses (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete cascade,
  slug text not null unique
    check (slug ~ '^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$')
    -- A página pública fica em /{slug}: nomes de rotas da plataforma não podem virar slug.
    check (slug not in (
      'login', 'cadastro', 'conta', 'auth', 'painel', 'api', 'admin', 'app', 'www', 'ajuda', 'suporte',
      'planos', 'precos', 'termos', 'privacidade', 'sobre', 'contato', 'blog', 'docs', 'status',
      'static', 'public', 'assets', 'images', 'img', 'icons', 'webhooks', 'pagamento', 'checkout',
      'agendamento', 'manifest', 'robots', 'sitemap', 'favicon', 'next'
    )),
  name text not null check (char_length(name) between 2 and 80),
  segment text not null check (segment in ('clinica', 'estetica', 'salao', 'bronze')),
  description text check (char_length(description) <= 300),
  -- Recado mostrado ao cliente depois de agendar (ex.: "Chegue 10 minutos antes").
  booking_notice text check (char_length(booking_notice) <= 500),
  phone text check (phone ~ '^[0-9]{10,11}$'),
  address text check (char_length(address) <= 200),
  logo_url text check (char_length(logo_url) <= 500),
  primary_color text not null default '#6d28d9' check (primary_color ~ '^#[0-9a-fA-F]{6}$'),
  -- Agenda online ligada: desligada, a página continua no ar mas não aceita novos agendamentos.
  is_accepting boolean not null default true,
  -- Agendamento feito pelo cliente já entra confirmado (true) ou aguarda o dono confirmar (false).
  auto_confirm boolean not null default true,
  -- Cliente escolhe o profissional (true) ou o sistema escolhe quem estiver livre (false).
  choose_professional boolean not null default true,
  slot_step_minutes integer not null default 30 check (slot_step_minutes in (5, 10, 15, 20, 30, 60)),
  min_notice_minutes integer not null default 60 check (min_notice_minutes between 0 and 10080),
  max_advance_days integer not null default 60 check (max_advance_days between 1 and 365),
  -- Cliente pode cancelar ou remarcar pelo link até esta antecedência.
  cancel_notice_minutes integer not null default 120 check (cancel_notice_minutes between 0 and 43200),
  ai_enabled boolean not null default true,
  created_at timestamptz not null default now()
);
-- Primeira versão: um estabelecimento por conta.
create unique index businesses_owner_idx on public.businesses (owner_id);

create table public.services (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete cascade,
  name text not null check (char_length(name) between 1 and 80),
  description text check (char_length(description) <= 500),
  category text check (char_length(category) <= 40),
  duration_minutes integer not null check (duration_minutes between 5 and 720 and duration_minutes % 5 = 0),
  price_cents integer not null default 0 check (price_cents between 0 and 100000000),
  -- "A partir de": o preço final depende da avaliação (comprimento do cabelo, área tratada...).
  price_from boolean not null default false,
  is_active boolean not null default true,
  position integer not null default 0,
  created_at timestamptz not null default now(),
  unique (id, business_id)
);
create index services_business_idx on public.services (business_id, position);

create table public.professionals (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete cascade,
  name text not null check (char_length(name) between 1 and 60),
  role text check (char_length(role) <= 60),
  is_active boolean not null default true,
  -- false: segue o expediente do estabelecimento; true: usa as linhas próprias de working_hours.
  custom_hours boolean not null default false,
  position integer not null default 0,
  created_at timestamptz not null default now(),
  unique (id, business_id)
);
create index professionals_business_idx on public.professionals (business_id, position);

-- Quem faz qual serviço.
create table public.professional_services (
  professional_id uuid not null,
  service_id uuid not null,
  business_id uuid not null references public.businesses (id) on delete cascade,
  primary key (professional_id, service_id),
  foreign key (professional_id, business_id) references public.professionals (id, business_id) on delete cascade,
  foreign key (service_id, business_id) references public.services (id, business_id) on delete cascade
);
create index professional_services_service_idx on public.professional_services (service_id);

-- Expediente por dia da semana (0 = domingo ... 6 = sábado), em períodos. Dois períodos no mesmo
-- dia (09:00-12:00 e 13:00-18:00) formam o intervalo. professional_id nulo = expediente da casa.
create table public.working_hours (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete cascade,
  professional_id uuid,
  weekday smallint not null check (weekday between 0 and 6),
  start_time time not null,
  end_time time not null,
  check (end_time > start_time),
  foreign key (professional_id, business_id) references public.professionals (id, business_id) on delete cascade
);
create index working_hours_business_idx on public.working_hours (business_id, professional_id, weekday);

-- Folgas e bloqueios. professional_id nulo = o estabelecimento inteiro.
create table public.blocks (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete cascade,
  professional_id uuid,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  reason text check (char_length(reason) <= 120),
  created_at timestamptz not null default now(),
  check (ends_at > starts_at),
  foreign key (professional_id, business_id) references public.professionals (id, business_id) on delete cascade
);
create index blocks_business_idx on public.blocks (business_id, starts_at);

-- Um cadastro por telefone em cada estabelecimento. Só contato: nada de prontuário.
create table public.customers (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete cascade,
  name text not null check (char_length(name) between 2 and 80),
  phone text not null check (phone ~ '^[0-9]{10,11}$'),
  -- Anotação interna do dono (preferências, lembretes). A tela avisa: não é lugar para informação de saúde.
  notes text check (char_length(notes) <= 500),
  created_at timestamptz not null default now(),
  unique (business_id, phone),
  unique (id, business_id)
);

create table public.appointments (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete cascade,
  -- Link secreto do cliente: quem tem o token vê, remarca e cancela.
  public_token uuid not null unique default gen_random_uuid(),
  service_id uuid,
  professional_id uuid not null,
  customer_id uuid not null,
  -- Cópia do que valia na hora do agendamento (o serviço pode mudar ou ser apagado depois).
  service_name text not null,
  duration_minutes integer not null check (duration_minutes between 5 and 720),
  price_cents integer not null check (price_cents >= 0),
  -- Nome informado neste agendamento (pode ser diferente do cadastro: mãe agendando para a filha).
  customer_name text not null,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  status text not null default 'confirmed'
    check (status in ('pending', 'confirmed', 'completed', 'no_show', 'canceled')),
  source text not null default 'web' check (source in ('web', 'ai', 'panel')),
  -- Observação do cliente. A tela avisa: não é lugar para informação de saúde.
  notes text check (char_length(notes) <= 300),
  cancel_reason text check (char_length(cancel_reason) <= 200),
  canceled_by text check (canceled_by in ('customer', 'business')),
  canceled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (extract(epoch from (ends_at - starts_at)) = duration_minutes * 60),
  foreign key (professional_id, business_id) references public.professionals (id, business_id),
  foreign key (customer_id, business_id) references public.customers (id, business_id) on delete cascade,
  foreign key (service_id, business_id) references public.services (id, business_id) on delete set null (service_id),
  -- A regra que não pode falhar: o mesmo profissional nunca tem dois agendamentos ativos no mesmo
  -- intervalo. É o banco que garante, então dois cliques simultâneos não passam.
  constraint appointments_no_overlap exclude using gist (
    professional_id with =,
    tstzrange(starts_at, ends_at, '[)') with &&
  ) where (status in ('pending', 'confirmed', 'completed'))
);
create index appointments_business_idx on public.appointments (business_id, starts_at);
create index appointments_customer_idx on public.appointments (customer_id, starts_at desc);

-- Contadores de limite de uso (agendamentos em sequência e, depois, mensagens para a IA).
create table public.rate_limits (
  key text not null,
  bucket timestamptz not null,
  hits integer not null default 1,
  primary key (key, bucket)
);

-- ---------------------------------------------------------------------------
-- Funções auxiliares
-- ---------------------------------------------------------------------------

-- Um lugar só para o fuso da plataforma.
create function public.tz()
returns text
language sql
immutable
set search_path = ''
as $$ select 'America/Sao_Paulo'::text $$;

-- "Hoje" em São Paulo.
create function public.local_today()
returns date
language sql
stable
set search_path = ''
as $$ select (now() at time zone public.tz())::date $$;

-- Data e hora do relógio de São Paulo -> instante.
create function public.local_ts(p_date date, p_time time)
returns timestamptz
language sql
immutable
set search_path = ''
as $$ select (p_date + p_time) at time zone 'America/Sao_Paulo' $$;

-- Só dígitos, sem o 55 do país: DDD + número (10 ou 11 dígitos). Nulo se inválido.
create function public.normalize_phone(p_phone text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case when d ~ '^[1-9][0-9]{9,10}$' then d end
  from (
    select case
      when raw ~ '^55[0-9]{10,11}$' then substr(raw, 3)
      else raw
    end as d
    from (select regexp_replace(coalesce(p_phone, ''), '\D', '', 'g') as raw) r
  ) n;
$$;

create function public.safe_uuid(p_value text)
returns uuid
language plpgsql
immutable
set search_path = ''
as $$
begin
  return nullif(btrim(p_value), '')::uuid;
exception when others then
  return null;
end;
$$;

create function public.safe_timestamptz(p_value text)
returns timestamptz
language plpgsql
stable
set search_path = ''
as $$
begin
  return nullif(btrim(p_value), '')::timestamptz;
exception when others then
  return null;
end;
$$;

create function public.safe_date(p_value text)
returns date
language plpgsql
stable
set search_path = ''
as $$
begin
  return nullif(btrim(p_value), '')::date;
exception when others then
  return null;
end;
$$;

create function public.safe_time(p_value text)
returns time
language plpgsql
immutable
set search_path = ''
as $$
begin
  return nullif(btrim(p_value), '')::time;
exception when others then
  return null;
end;
$$;

create function public.is_business_owner(p_business_id uuid)
returns boolean
language sql
stable
set search_path = ''
as $$
  select exists (
    select 1 from public.businesses b
    where b.id = p_business_id and b.owner_id = (select auth.uid())
  );
$$;

create function public.touch_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger appointments_touch_updated_at
before update on public.appointments
for each row execute function public.touch_updated_at();

-- Conta um uso na janela atual e devolve quantos já foram. Interna.
create function public.rate_touch(p_key text, p_window interval)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_hits integer;
begin
  insert into public.rate_limits (key, bucket)
  values (left(p_key, 200), date_bin(p_window, now(), 'epoch'::timestamptz))
  on conflict (key, bucket) do update set hits = public.rate_limits.hits + 1
  returning hits into v_hits;

  if random() < 0.02 then
    delete from public.rate_limits where bucket < now() - interval '2 days';
  end if;
  return v_hits;
end;
$$;

-- Identifica quem chama a API sem guardar o IP: só um hash, que muda a cada dia.
-- Nulo quando não há requisição HTTP (migrações, testes e rotinas internas).
create function public.request_client_hash()
returns text
language plpgsql
stable
set search_path = ''
as $$
declare
  v_headers json;
  v_ip text;
begin
  begin
    v_headers := nullif(current_setting('request.headers', true), '')::json;
  exception when others then
    return null;
  end;
  if v_headers is null then
    return null;
  end if;
  v_ip := coalesce(
    nullif(btrim(v_headers ->> 'cf-connecting-ip'), ''),
    nullif(btrim(split_part(coalesce(v_headers ->> 'x-forwarded-for', ''), ',', 1)), ''),
    'desconhecido'
  );
  return left(encode(sha256(convert_to(v_ip || ':' || public.local_today()::text, 'utf8')), 'hex'), 32);
end;
$$;

-- ---------------------------------------------------------------------------
-- Modelos por segmento: serviços e regras típicas, para o dono ajustar.
-- Serviço = [categoria, nome, duração em minutos, preço em centavos, "a partir de", descrição].
-- Expediente = [dia da semana, início, fim].
-- ---------------------------------------------------------------------------

create function public.segment_template(p_segment text)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select case p_segment
    when 'salao' then '{
      "primary_color": "#be185d", "auto_confirm": true, "choose_professional": true,
      "slot_step_minutes": 30, "min_notice_minutes": 60, "max_advance_days": 60, "cancel_notice_minutes": 120,
      "hours": [[2,"09:00","19:00"],[3,"09:00","19:00"],[4,"09:00","19:00"],[5,"09:00","19:00"],[6,"09:00","18:00"]],
      "services": [
        ["Cabelo","Corte feminino",60,8000,false,"Lavagem, corte e finalização simples."],
        ["Cabelo","Corte masculino",30,4500,false,null],
        ["Cabelo","Escova",45,6000,false,null],
        ["Cabelo","Hidratação",45,7000,false,null],
        ["Cabelo","Coloração",120,18000,true,"O valor final depende do comprimento e do produto."],
        ["Cabelo","Mechas",180,35000,true,"O valor final depende do comprimento e da técnica."],
        ["Cabelo","Progressiva",150,25000,true,null],
        ["Unhas","Manicure",40,3500,false,null],
        ["Unhas","Pedicure",45,4000,false,null],
        ["Unhas","Manicure e pedicure",80,7000,false,null],
        ["Sobrancelha","Design de sobrancelha",30,4000,false,null],
        ["Barba","Barba",30,3500,false,null]
      ]}'::jsonb
    when 'estetica' then '{
      "primary_color": "#6d28d9", "auto_confirm": true, "choose_professional": true,
      "slot_step_minutes": 30, "min_notice_minutes": 120, "max_advance_days": 60, "cancel_notice_minutes": 1440,
      "hours": [[1,"09:00","19:00"],[2,"09:00","19:00"],[3,"09:00","19:00"],[4,"09:00","19:00"],[5,"09:00","19:00"],[6,"09:00","14:00"]],
      "services": [
        ["Facial","Limpeza de pele",60,15000,false,null],
        ["Facial","Peeling facial",45,18000,true,null],
        ["Facial","Microagulhamento",60,28000,false,null],
        ["Corporal","Drenagem linfática",60,13000,false,null],
        ["Corporal","Massagem modeladora",50,12000,false,null],
        ["Corporal","Massagem relaxante",60,14000,false,null],
        ["Depilação","Depilação a laser",30,12000,true,"O valor depende da área."],
        ["Depilação","Depilação com cera",40,7000,true,"O valor depende da área."],
        ["Cílios e sobrancelhas","Design de sobrancelha",30,4500,false,null],
        ["Cílios e sobrancelhas","Extensão de cílios",120,22000,false,null]
      ]}'::jsonb
    when 'clinica' then '{
      "primary_color": "#0f766e", "auto_confirm": false, "choose_professional": true,
      "slot_step_minutes": 30, "min_notice_minutes": 120, "max_advance_days": 90, "cancel_notice_minutes": 1440,
      "hours": [[1,"08:00","12:00"],[1,"13:00","18:00"],[2,"08:00","12:00"],[2,"13:00","18:00"],[3,"08:00","12:00"],[3,"13:00","18:00"],[4,"08:00","12:00"],[4,"13:00","18:00"],[5,"08:00","12:00"],[5,"13:00","18:00"]],
      "services": [
        [null,"Consulta",30,20000,false,null],
        [null,"Retorno",20,0,false,null],
        [null,"Avaliação inicial",40,15000,false,null]
      ]}'::jsonb
    when 'bronze' then '{
      "primary_color": "#b45309", "auto_confirm": true, "choose_professional": false,
      "slot_step_minutes": 30, "min_notice_minutes": 120, "max_advance_days": 30, "cancel_notice_minutes": 240,
      "hours": [[0,"08:00","13:00"],[2,"08:00","17:00"],[3,"08:00","17:00"],[4,"08:00","17:00"],[5,"08:00","17:00"],[6,"08:00","17:00"]],
      "services": [
        ["Bronzeamento","Bronzeamento natural",120,13000,false,"Com fita, na área de sol."],
        ["Bronzeamento","Bronzeamento a jato",30,11000,false,null],
        ["Bronzeamento","Bronzeamento em cabine",20,7000,false,null],
        ["Cuidados","Esfoliação corporal",30,5000,false,null],
        ["Cuidados","Hidratação pós-bronze",30,4500,false,null],
        ["Cuidados","Banho de lua",60,9000,false,null]
      ]}'::jsonb
  end;
$$;

-- ---------------------------------------------------------------------------
-- Criação do estabelecimento: única porta de entrada. Aplica o modelo do segmento.
-- ---------------------------------------------------------------------------

create function public.create_business(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_name text := btrim(regexp_replace(coalesce(p ->> 'name', ''), '\s+', ' ', 'g'));
  v_slug text := lower(btrim(coalesce(p ->> 'slug', '')));
  v_segment text := p ->> 'segment';
  v_phone text := public.normalize_phone(p ->> 'phone');
  v_professional text := btrim(regexp_replace(coalesce(p ->> 'professional_name', ''), '\s+', ' ', 'g'));
  v_template jsonb;
  v_business_id uuid;
  v_professional_id uuid;
  v_item jsonb;
  v_position integer := 0;
begin
  if v_user is null then
    raise exception 'Faça login para criar o estabelecimento.' using errcode = 'AG401';
  end if;
  if exists (select 1 from public.businesses where owner_id = v_user) then
    raise exception 'Esta conta já tem um estabelecimento.' using errcode = 'AG409';
  end if;
  v_template := public.segment_template(v_segment);
  if v_template is null then
    raise exception 'Escolha o tipo do estabelecimento.' using errcode = 'AG422';
  end if;
  if char_length(v_name) < 2 or char_length(v_name) > 80 then
    raise exception 'Informe o nome do estabelecimento.' using errcode = 'AG422';
  end if;
  if nullif(btrim(coalesce(p ->> 'phone', '')), '') is not null and v_phone is null then
    raise exception 'Informe um WhatsApp válido com DDD.' using errcode = 'AG422';
  end if;
  if char_length(v_professional) > 60 then
    raise exception 'Nome do profissional muito longo.' using errcode = 'AG422';
  end if;

  begin
    insert into public.businesses (
      owner_id, slug, name, segment, phone, primary_color, auto_confirm, choose_professional,
      slot_step_minutes, min_notice_minutes, max_advance_days, cancel_notice_minutes
    ) values (
      v_user, v_slug, v_name, v_segment, v_phone, v_template ->> 'primary_color',
      (v_template ->> 'auto_confirm')::boolean, (v_template ->> 'choose_professional')::boolean,
      (v_template ->> 'slot_step_minutes')::integer, (v_template ->> 'min_notice_minutes')::integer,
      (v_template ->> 'max_advance_days')::integer, (v_template ->> 'cancel_notice_minutes')::integer
    )
    returning id into v_business_id;
  exception
    when unique_violation then
      raise exception 'Este endereço já está em uso. Escolha outro.' using errcode = 'AG409';
    when check_violation then
      raise exception 'Escolha um endereço com 3 a 40 letras minúsculas, números ou hífen.' using errcode = 'AG422';
  end;

  insert into public.working_hours (business_id, weekday, start_time, end_time)
  select v_business_id, (h ->> 0)::smallint, (h ->> 1)::time, (h ->> 2)::time
  from jsonb_array_elements(v_template -> 'hours') as h;

  for v_item in select * from jsonb_array_elements(v_template -> 'services')
  loop
    v_position := v_position + 1;
    insert into public.services (business_id, category, name, duration_minutes, price_cents, price_from, description, position)
    values (
      v_business_id, v_item ->> 0, v_item ->> 1, (v_item ->> 2)::integer, (v_item ->> 3)::integer,
      (v_item ->> 4)::boolean, v_item ->> 5, v_position
    );
  end loop;

  -- Primeiro profissional, já ligado a todos os serviços do modelo.
  insert into public.professionals (business_id, name, position)
  values (v_business_id, coalesce(nullif(v_professional, ''), 'Profissional 1'), 1)
  returning id into v_professional_id;

  insert into public.professional_services (professional_id, service_id, business_id)
  select v_professional_id, s.id, v_business_id from public.services s where s.business_id = v_business_id;

  return jsonb_build_object('id', v_business_id, 'slug', v_slug);
end;
$$;

-- ---------------------------------------------------------------------------
-- Horário livre: a função única que todo mundo usa (página, IA, painel).
-- Considera duração do serviço, expediente (com intervalos), bloqueios, antecedência mínima,
-- janela máxima e os agendamentos existentes. Interna: só é chamada por outras funções.
-- ---------------------------------------------------------------------------

create function public.slot_candidates(
  p_business_id uuid,
  p_service_id uuid,
  p_professional_id uuid,          -- nulo = qualquer profissional ativo que faça o serviço
  p_from date,                     -- datas no relógio de São Paulo, inclusive
  p_to date,
  p_ignore_appointment uuid,       -- ao remarcar: o próprio agendamento não ocupa o horário
  p_public_rules boolean           -- true: aplica antecedência mínima e janela máxima
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
    -- Expediente que vale para cada profissional em cada dia: o próprio ou o da casa.
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
        and a.id is distinct from p_ignore_appointment
        and a.starts_at < sl.ends_at and a.ends_at > sl.starts_at
    );
$$;

-- Horários livres para a página pública e para a IA. Devolve, por dia, o instante ("at") e a
-- hora já no relógio de São Paulo ("time"), para o navegador não fazer conta de fuso.
create function public.get_availability(
  p_business_id uuid,
  p_service_id uuid,
  p_professional_id uuid default null,
  p_from date default null,
  p_days integer default 14,
  p_token uuid default null        -- ao remarcar: token do próprio agendamento
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_business public.businesses%rowtype;
  v_today date := public.local_today();
  v_last date;
  v_from date;
  v_to date;
  v_ignore uuid;
  v_days jsonb;
begin
  select * into v_business from public.businesses where id = p_business_id;
  if not found then
    raise exception 'Estabelecimento não encontrado.' using errcode = 'AG404';
  end if;
  if not exists (
    select 1 from public.services s
    where s.id = p_service_id and s.business_id = p_business_id and s.is_active
  ) then
    raise exception 'Serviço não encontrado.' using errcode = 'AG404';
  end if;

  v_last := v_today + v_business.max_advance_days;
  v_from := greatest(coalesce(p_from, v_today), v_today);
  v_to := least(v_from + least(greatest(coalesce(p_days, 14), 1), 62) - 1, v_last);

  if p_token is not null then
    select a.id into v_ignore from public.appointments a
    where a.public_token = p_token and a.business_id = p_business_id and a.status in ('pending', 'confirmed');
  end if;

  if v_business.is_accepting and v_from <= v_to then
    select jsonb_agg(jsonb_build_object('date', d.day, 'slots', d.slots) order by d.day) into v_days
    from (
      select (x.starts_at at time zone public.tz())::date as day,
             jsonb_agg(jsonb_build_object(
               'at', to_char(x.starts_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
               'time', to_char(x.starts_at at time zone public.tz(), 'HH24:MI')
             ) order by x.starts_at) as slots
      from (
        select distinct sc.starts_at
        from public.slot_candidates(p_business_id, p_service_id, p_professional_id, v_from, v_to, v_ignore, true) sc
      ) x
      group by 1
    ) d;
  end if;

  return jsonb_build_object(
    'today', v_today,
    'from', v_from,
    'to', v_to,
    'last_date', v_last,
    'accepting', v_business.is_accepting,
    'days', coalesce(v_days, '[]'::jsonb)
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Agendamento pelo cliente (página pública e IA): única porta de entrada para anônimos.
-- Nada vindo do cliente é confiado: serviço, duração, preço e disponibilidade saem do banco.
-- ---------------------------------------------------------------------------

create function public.book_appointment(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_business public.businesses%rowtype;
  v_service public.services%rowtype;
  v_professional_id uuid := public.safe_uuid(p ->> 'professional_id');
  v_starts_at timestamptz := public.safe_timestamptz(p ->> 'starts_at');
  v_name text := btrim(regexp_replace(coalesce(p ->> 'customer_name', ''), '\s+', ' ', 'g'));
  v_phone text := public.normalize_phone(p ->> 'customer_phone');
  v_notes text := nullif(btrim(coalesce(p ->> 'notes', '')), '');
  v_source text := case when p ->> 'source' = 'ai' then 'ai' else 'web' end;
  v_client text := public.request_client_hash();
  v_day date;
  v_customer_id uuid;
  v_candidate record;
  v_appointment public.appointments%rowtype;
begin
  select * into v_business from public.businesses where id = public.safe_uuid(p ->> 'business_id');
  if not found then
    raise exception 'Estabelecimento não encontrado.' using errcode = 'AG404';
  end if;
  if not v_business.is_accepting then
    raise exception 'Este estabelecimento não está aceitando agendamentos online no momento.' using errcode = 'AG403';
  end if;

  select * into v_service from public.services
  where id = public.safe_uuid(p ->> 'service_id') and business_id = v_business.id and is_active;
  if not found then
    raise exception 'Serviço não encontrado.' using errcode = 'AG404';
  end if;
  if v_starts_at is null then
    raise exception 'Escolha o dia e o horário.' using errcode = 'AG422';
  end if;
  if char_length(v_name) < 2 or char_length(v_name) > 80 then
    raise exception 'Informe seu nome.' using errcode = 'AG422';
  end if;
  if v_phone is null then
    raise exception 'Informe um WhatsApp válido com DDD.' using errcode = 'AG422';
  end if;
  if char_length(coalesce(v_notes, '')) > 300 then
    raise exception 'Observação muito longa.' using errcode = 'AG422';
  end if;

  -- Proteção contra enxurrada de agendamentos falsos.
  if (
    select count(*) from public.appointments a
    join public.customers c on c.id = a.customer_id
    where a.business_id = v_business.id and c.phone = v_phone
      and a.status in ('pending', 'confirmed') and a.starts_at > now()
  ) >= 5 then
    raise exception 'Este telefone já tem muitos agendamentos em aberto. Fale com o estabelecimento.' using errcode = 'AG429';
  end if;
  if public.rate_touch('book:b:' || v_business.id, interval '1 hour') > 60
     or (v_client is not null
         and public.rate_touch('book:c:' || v_business.id || ':' || v_client, interval '1 hour') > 20) then
    raise exception 'Muitos agendamentos em sequência. Tente de novo em alguns minutos.' using errcode = 'AG429';
  end if;

  v_day := (v_starts_at at time zone public.tz())::date;

  insert into public.customers (business_id, name, phone)
  values (v_business.id, v_name, v_phone)
  on conflict (business_id, phone) do update set phone = excluded.phone
  returning id into v_customer_id;

  -- Profissional escolhido, ou "qualquer um": começa por quem tem o dia mais vazio.
  for v_candidate in
    select sc.professional_id, sc.ends_at
    from public.slot_candidates(v_business.id, v_service.id, v_professional_id, v_day, v_day, null, true) sc
    join public.professionals pr on pr.id = sc.professional_id
    where sc.starts_at = v_starts_at
    order by (
      select count(*) from public.appointments a
      where a.professional_id = sc.professional_id
        and a.status in ('pending', 'confirmed', 'completed')
        and a.starts_at >= public.local_ts(v_day, '00:00')
        and a.starts_at < public.local_ts(v_day + 1, '00:00')
    ), pr.position, pr.name, pr.id
  loop
    begin
      insert into public.appointments (
        business_id, service_id, professional_id, customer_id, service_name, duration_minutes,
        price_cents, customer_name, starts_at, ends_at, status, source, notes
      ) values (
        v_business.id, v_service.id, v_candidate.professional_id, v_customer_id, v_service.name,
        v_service.duration_minutes, v_service.price_cents, v_name, v_starts_at, v_candidate.ends_at,
        case when v_business.auto_confirm then 'confirmed' else 'pending' end, v_source, v_notes
      )
      returning * into v_appointment;
      exit;
    exception when exclusion_violation then
      -- Outra pessoa ficou com este horário neste instante: tenta o próximo profissional livre.
      null;
    end;
  end loop;

  if v_appointment.id is null then
    raise exception 'Este horário não está mais disponível. Escolha outro.' using errcode = 'AG409';
  end if;

  return jsonb_build_object(
    'token', v_appointment.public_token,
    'status', v_appointment.status,
    'starts_at', v_appointment.starts_at,
    'date', (v_appointment.starts_at at time zone public.tz())::date,
    'time', to_char(v_appointment.starts_at at time zone public.tz(), 'HH24:MI'),
    'service_name', v_appointment.service_name,
    'price_cents', v_appointment.price_cents,
    'professional_name', (select pr.name from public.professionals pr where pr.id = v_appointment.professional_id)
  );
end;
$$;

-- Página do agendamento: só quem tem o link secreto enxerga. Não devolve telefone.
create function public.get_appointment(p_token uuid)
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
    -- Cancelar e remarcar pelo link: só agendamento ativo e dentro do prazo do estabelecimento.
    'can_change', a.status in ('pending', 'confirmed')
      and now() <= a.starts_at - make_interval(mins => b.cancel_notice_minutes),
    'change_deadline', a.starts_at - make_interval(mins => b.cancel_notice_minutes),
    'is_past', a.starts_at <= now(),
    'business', jsonb_build_object(
      'id', b.id, 'slug', b.slug, 'name', b.name, 'phone', b.phone, 'address', b.address,
      'logo_url', b.logo_url, 'primary_color', b.primary_color, 'booking_notice', b.booking_notice,
      'cancel_notice_minutes', b.cancel_notice_minutes, 'choose_professional', b.choose_professional
    )
  )
  from public.appointments a
  join public.businesses b on b.id = a.business_id
  join public.professionals pr on pr.id = a.professional_id
  where a.public_token = p_token;
$$;

create function public.cancel_appointment(p_token uuid, p_reason text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_appointment public.appointments%rowtype;
  v_notice integer;
begin
  select a.* into v_appointment from public.appointments a where a.public_token = p_token for update;
  if not found then
    raise exception 'Agendamento não encontrado.' using errcode = 'AG404';
  end if;
  if v_appointment.status = 'canceled' then
    return jsonb_build_object('status', 'canceled');
  end if;
  if v_appointment.status not in ('pending', 'confirmed') then
    raise exception 'Este agendamento não pode mais ser cancelado.' using errcode = 'AG409';
  end if;
  select b.cancel_notice_minutes into v_notice from public.businesses b where b.id = v_appointment.business_id;
  if now() > v_appointment.starts_at - make_interval(mins => v_notice) then
    raise exception 'O prazo para cancelar pelo site terminou. Fale com o estabelecimento.' using errcode = 'AG403';
  end if;

  update public.appointments
     set status = 'canceled', canceled_by = 'customer', canceled_at = now(),
         cancel_reason = nullif(left(btrim(coalesce(p_reason, '')), 200), '')
   where id = v_appointment.id;
  return jsonb_build_object('status', 'canceled');
end;
$$;

create function public.reschedule_appointment(
  p_token uuid,
  p_starts_at timestamptz,
  p_professional_id uuid default null   -- nulo: mantém o profissional se ele estiver livre; senão, outro que faça o serviço
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_appointment public.appointments%rowtype;
  v_business public.businesses%rowtype;
  v_service public.services%rowtype;
  v_day date;
  v_candidate record;
  v_done boolean := false;
begin
  select a.* into v_appointment from public.appointments a where a.public_token = p_token for update;
  if not found then
    raise exception 'Agendamento não encontrado.' using errcode = 'AG404';
  end if;
  if v_appointment.status not in ('pending', 'confirmed') then
    raise exception 'Este agendamento não pode mais ser remarcado.' using errcode = 'AG409';
  end if;
  select * into v_business from public.businesses where id = v_appointment.business_id;
  if now() > v_appointment.starts_at - make_interval(mins => v_business.cancel_notice_minutes) then
    raise exception 'O prazo para remarcar pelo site terminou. Fale com o estabelecimento.' using errcode = 'AG403';
  end if;
  if not v_business.is_accepting then
    raise exception 'Este estabelecimento não está aceitando agendamentos online no momento.' using errcode = 'AG403';
  end if;
  select * into v_service from public.services
  where id = v_appointment.service_id and business_id = v_business.id and is_active;
  if not found then
    raise exception 'Este serviço não está mais disponível online. Fale com o estabelecimento para remarcar.' using errcode = 'AG409';
  end if;
  if p_starts_at is null then
    raise exception 'Escolha o novo dia e horário.' using errcode = 'AG422';
  end if;
  if p_starts_at = v_appointment.starts_at
     and (p_professional_id is null or p_professional_id = v_appointment.professional_id) then
    raise exception 'Este já é o horário do seu agendamento.' using errcode = 'AG422';
  end if;

  v_day := (p_starts_at at time zone public.tz())::date;

  for v_candidate in
    select sc.professional_id, sc.ends_at
    from public.slot_candidates(v_business.id, v_service.id, p_professional_id, v_day, v_day, v_appointment.id, true) sc
    join public.professionals pr on pr.id = sc.professional_id
    where sc.starts_at = p_starts_at
    order by (sc.professional_id = v_appointment.professional_id) desc, pr.position, pr.name, pr.id
  loop
    begin
      update public.appointments
         set starts_at = p_starts_at, ends_at = v_candidate.ends_at,
             duration_minutes = v_service.duration_minutes,
             professional_id = v_candidate.professional_id,
             status = case when v_business.auto_confirm then 'confirmed' else 'pending' end
       where id = v_appointment.id;
      v_done := true;
      exit;
    exception when exclusion_violation then
      null;
    end;
  end loop;

  if not v_done then
    raise exception 'Este horário não está mais disponível. Escolha outro.' using errcode = 'AG409';
  end if;

  return public.get_appointment(p_token);
end;
$$;

-- ---------------------------------------------------------------------------
-- Painel do dono. Leituras simples usam as tabelas (protegidas por RLS); o que envolve regra
-- de agenda ou conversão de fuso passa por funções.
-- ---------------------------------------------------------------------------

create function public.require_owner(p_business_id uuid)
returns void
language plpgsql
stable
set search_path = ''
as $$
begin
  if p_business_id is null or not public.is_business_owner(p_business_id) then
    raise exception 'Sem permissão para este estabelecimento.' using errcode = 'AG403';
  end if;
end;
$$;

-- Agendamento no formato que o painel usa, com as horas já no relógio de São Paulo.
create function public.appointment_json(a public.appointments)
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
    'created_at', a.created_at
  );
$$;

-- Agenda de um período: agendamentos e bloqueios, com datas de São Paulo.
create function public.owner_agenda(p_business_id uuid, p_from date, p_to date)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform public.require_owner(p_business_id);
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 62 then
    raise exception 'Período inválido.' using errcode = 'AG422';
  end if;
  return jsonb_build_object(
    'today', public.local_today(),
    'now_time', to_char(now() at time zone public.tz(), 'HH24:MI'),
    'appointments', coalesce((
      select jsonb_agg(public.appointment_json(a) order by a.starts_at, a.created_at)
      from public.appointments a
      where a.business_id = p_business_id
        and a.starts_at >= public.local_ts(p_from, '00:00')
        and a.starts_at < public.local_ts(p_to + 1, '00:00')
    ), '[]'::jsonb),
    'blocks', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', k.id,
        'professional_id', k.professional_id,
        'reason', k.reason,
        'starts_at', k.starts_at,
        'ends_at', k.ends_at,
        'start_date', (k.starts_at at time zone public.tz())::date,
        'start_time', to_char(k.starts_at at time zone public.tz(), 'HH24:MI'),
        'end_date', (k.ends_at at time zone public.tz())::date,
        'end_time', to_char(k.ends_at at time zone public.tz(), 'HH24:MI')
      ) order by k.starts_at)
      from public.blocks k
      where k.business_id = p_business_id
        and k.starts_at < public.local_ts(p_to + 1, '00:00')
        and k.ends_at > public.local_ts(p_from, '00:00')
    ), '[]'::jsonb)
  );
end;
$$;

-- Horários livres de um dia para o dono encaixar um cliente. Não aplica antecedência mínima
-- nem janela máxima (isso é regra para o cliente), mas não mostra horário que já passou.
create function public.owner_availability(
  p_business_id uuid,
  p_service_id uuid,
  p_professional_id uuid,
  p_date date,
  p_ignore_appointment uuid default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform public.require_owner(p_business_id);
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'professional_id', sc.professional_id,
      'at', to_char(sc.starts_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
      'time', to_char(sc.starts_at at time zone public.tz(), 'HH24:MI')
    ) order by sc.starts_at, sc.professional_id)
    from public.slot_candidates(p_business_id, p_service_id, p_professional_id, p_date, p_date, p_ignore_appointment, false) sc
    where sc.starts_at > now()
  ), '[]'::jsonb);
end;
$$;

-- Agendamento manual. Com "force" o dono pode encaixar fora do expediente ou em cima de um
-- bloqueio; nem assim dois agendamentos ocupam o mesmo profissional no mesmo horário.
create function public.owner_create_appointment(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_business_id uuid := public.safe_uuid(p ->> 'business_id');
  v_service public.services%rowtype;
  v_professional_id uuid := public.safe_uuid(p ->> 'professional_id');
  v_starts_at timestamptz := public.safe_timestamptz(p ->> 'starts_at');
  v_date date := public.safe_date(p ->> 'date');
  v_time time := public.safe_time(p ->> 'time');
  v_force boolean := coalesce(p ->> 'force', 'false') = 'true';
  v_name text := btrim(regexp_replace(coalesce(p ->> 'customer_name', ''), '\s+', ' ', 'g'));
  v_phone text := public.normalize_phone(p ->> 'customer_phone');
  v_notes text := nullif(btrim(coalesce(p ->> 'notes', '')), '');
  v_ends_at timestamptz;
  v_day date;
  v_customer_id uuid;
  v_appointment public.appointments%rowtype;
begin
  perform public.require_owner(v_business_id);

  select * into v_service from public.services where id = public.safe_uuid(p ->> 'service_id') and business_id = v_business_id;
  if not found then
    raise exception 'Escolha o serviço.' using errcode = 'AG422';
  end if;
  if not exists (
    select 1 from public.professional_services ps
    where ps.professional_id = v_professional_id and ps.service_id = v_service.id and ps.business_id = v_business_id
  ) then
    raise exception 'Escolha um profissional que faça este serviço.' using errcode = 'AG422';
  end if;
  -- Horário: um instante vindo da lista de horários livres, ou data e hora de São Paulo digitadas.
  if v_starts_at is null and v_date is not null and v_time is not null then
    v_starts_at := public.local_ts(v_date, v_time);
  end if;
  if v_starts_at is null then
    raise exception 'Escolha o dia e o horário.' using errcode = 'AG422';
  end if;
  if char_length(v_name) < 2 or char_length(v_name) > 80 then
    raise exception 'Informe o nome do cliente.' using errcode = 'AG422';
  end if;
  if v_phone is null then
    raise exception 'Informe o WhatsApp do cliente com DDD.' using errcode = 'AG422';
  end if;
  if char_length(coalesce(v_notes, '')) > 300 then
    raise exception 'Observação muito longa.' using errcode = 'AG422';
  end if;

  v_ends_at := v_starts_at + make_interval(mins => v_service.duration_minutes);
  v_day := (v_starts_at at time zone public.tz())::date;

  if not v_force and not exists (
    select 1 from public.slot_candidates(v_business_id, v_service.id, v_professional_id, v_day, v_day, null, false) sc
    where sc.starts_at = v_starts_at
  ) then
    raise exception 'Este horário está fora do expediente, bloqueado ou ocupado. Marque "encaixe" para agendar mesmo assim.' using errcode = 'AG409';
  end if;

  insert into public.customers (business_id, name, phone)
  values (v_business_id, v_name, v_phone)
  on conflict (business_id, phone) do update set phone = excluded.phone
  returning id into v_customer_id;

  begin
    insert into public.appointments (
      business_id, service_id, professional_id, customer_id, service_name, duration_minutes,
      price_cents, customer_name, starts_at, ends_at, status, source, notes
    ) values (
      v_business_id, v_service.id, v_professional_id, v_customer_id, v_service.name, v_service.duration_minutes,
      v_service.price_cents, v_name, v_starts_at, v_ends_at, 'confirmed', 'panel', v_notes
    )
    returning * into v_appointment;
  exception when exclusion_violation then
    raise exception 'Este profissional já tem um agendamento neste horário.' using errcode = 'AG409';
  end;

  return public.appointment_json(v_appointment);
end;
$$;

-- Confirmar, cancelar, marcar falta, concluir e desfazer.
create function public.owner_set_appointment_status(p_appointment_id uuid, p_status text, p_reason text default null)
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

  if p_status is null or p_status not in ('confirmed', 'completed', 'no_show', 'canceled') then
    raise exception 'Situação inválida.' using errcode = 'AG422';
  end if;
  if p_status = v_appointment.status then
    return public.appointment_json(v_appointment);
  end if;
  if p_status in ('completed', 'no_show') then
    if v_appointment.status = 'canceled' then
      raise exception 'Este agendamento foi cancelado. Reative antes de mudar a situação.' using errcode = 'AG409';
    end if;
    if v_appointment.starts_at > now() then
      raise exception 'Este atendimento ainda não começou.' using errcode = 'AG409';
    end if;
  end if;
  if p_status = 'canceled' and v_appointment.status not in ('pending', 'confirmed') then
    raise exception 'Só dá para cancelar agendamento em aberto.' using errcode = 'AG409';
  end if;

  begin
    if p_status = 'canceled' then
      update public.appointments
         set status = 'canceled', canceled_by = 'business', canceled_at = now(),
             cancel_reason = nullif(left(btrim(coalesce(p_reason, '')), 200), '')
       where id = v_appointment.id
      returning * into v_appointment;
    else
      update public.appointments
         set status = p_status, canceled_by = null, canceled_at = null, cancel_reason = null
       where id = v_appointment.id
      returning * into v_appointment;
    end if;
  exception when exclusion_violation then
    -- Reativar um cancelado ou uma falta cujo horário já foi dado a outra pessoa.
    raise exception 'Este horário já foi ocupado por outro agendamento.' using errcode = 'AG409';
  end;

  return public.appointment_json(v_appointment);
end;
$$;

-- Remarcar pelo painel: novo horário e, se quiser, outro profissional.
create function public.owner_reschedule_appointment(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_appointment public.appointments%rowtype;
  v_professional_id uuid := public.safe_uuid(p ->> 'professional_id');
  v_starts_at timestamptz := public.safe_timestamptz(p ->> 'starts_at');
  v_date date := public.safe_date(p ->> 'date');
  v_time time := public.safe_time(p ->> 'time');
  v_force boolean := coalesce(p ->> 'force', 'false') = 'true';
  v_duration integer;
  v_ends_at timestamptz;
  v_day date;
begin
  select a.* into v_appointment from public.appointments a
  where a.id = public.safe_uuid(p ->> 'appointment_id') for update;
  if not found then
    raise exception 'Agendamento não encontrado.' using errcode = 'AG404';
  end if;
  perform public.require_owner(v_appointment.business_id);
  if v_appointment.status not in ('pending', 'confirmed') then
    raise exception 'Só dá para remarcar agendamento em aberto.' using errcode = 'AG409';
  end if;

  v_professional_id := coalesce(v_professional_id, v_appointment.professional_id);
  if not exists (
    select 1 from public.professionals pr
    where pr.id = v_professional_id and pr.business_id = v_appointment.business_id
  ) then
    raise exception 'Profissional não encontrado.' using errcode = 'AG422';
  end if;
  if v_starts_at is null and v_date is not null and v_time is not null then
    v_starts_at := public.local_ts(v_date, v_time);
  end if;
  if v_starts_at is null then
    raise exception 'Escolha o novo dia e horário.' using errcode = 'AG422';
  end if;

  -- A duração acompanha o serviço como ele está hoje; se o serviço foi apagado, vale a que ficou gravada.
  select s.duration_minutes into v_duration from public.services s where s.id = v_appointment.service_id;
  v_duration := coalesce(v_duration, v_appointment.duration_minutes);
  v_ends_at := v_starts_at + make_interval(mins => v_duration);
  v_day := (v_starts_at at time zone public.tz())::date;

  if not v_force then
    if v_appointment.service_id is null or not exists (
      select 1 from public.slot_candidates(
        v_appointment.business_id, v_appointment.service_id, v_professional_id, v_day, v_day, v_appointment.id, false) sc
      where sc.starts_at = v_starts_at
    ) then
      raise exception 'Este horário está fora do expediente, bloqueado ou ocupado. Marque "encaixe" para remarcar mesmo assim.' using errcode = 'AG409';
    end if;
  end if;

  begin
    update public.appointments
       set starts_at = v_starts_at, ends_at = v_ends_at, duration_minutes = v_duration,
           professional_id = v_professional_id
     where id = v_appointment.id
    returning * into v_appointment;
  exception when exclusion_violation then
    raise exception 'Este profissional já tem um agendamento neste horário.' using errcode = 'AG409';
  end;

  return public.appointment_json(v_appointment);
end;
$$;

-- Bloqueio ou folga, com data e hora no relógio de São Paulo.
create function public.owner_create_block(
  p_business_id uuid,
  p_professional_id uuid,     -- nulo = o estabelecimento inteiro
  p_start_date date,
  p_start_time time,
  p_end_date date,
  p_end_time time,
  p_reason text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_starts_at timestamptz;
  v_ends_at timestamptz;
  v_id uuid;
begin
  perform public.require_owner(p_business_id);
  if p_start_date is null or p_end_date is null or p_start_time is null or p_end_time is null then
    raise exception 'Informe o início e o fim do bloqueio.' using errcode = 'AG422';
  end if;
  if p_professional_id is not null and not exists (
    select 1 from public.professionals pr where pr.id = p_professional_id and pr.business_id = p_business_id
  ) then
    raise exception 'Profissional não encontrado.' using errcode = 'AG422';
  end if;
  v_starts_at := public.local_ts(p_start_date, p_start_time);
  v_ends_at := public.local_ts(p_end_date, p_end_time);
  if v_ends_at <= v_starts_at then
    raise exception 'O fim do bloqueio precisa ser depois do início.' using errcode = 'AG422';
  end if;
  if v_ends_at - v_starts_at > interval '366 days' then
    raise exception 'Bloqueio longo demais.' using errcode = 'AG422';
  end if;

  insert into public.blocks (business_id, professional_id, starts_at, ends_at, reason)
  values (p_business_id, p_professional_id, v_starts_at, v_ends_at, nullif(left(btrim(coalesce(p_reason, '')), 120), ''))
  returning id into v_id;

  -- Avisa quantos agendamentos em aberto ficaram debaixo do bloqueio (o bloqueio não cancela ninguém).
  return jsonb_build_object(
    'id', v_id,
    'conflicts', (
      select count(*) from public.appointments a
      where a.business_id = p_business_id
        and a.status in ('pending', 'confirmed')
        and (p_professional_id is null or a.professional_id = p_professional_id)
        and a.starts_at < v_ends_at and a.ends_at > v_starts_at
    )
  );
end;
$$;

-- Troca o expediente inteiro (da casa ou de um profissional) de uma vez.
-- p_hours: [{"weekday": 1, "start": "09:00", "end": "12:00"}, ...]
create function public.set_working_hours(p_business_id uuid, p_professional_id uuid, p_hours jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row record;
begin
  perform public.require_owner(p_business_id);
  if p_professional_id is not null and not exists (
    select 1 from public.professionals pr where pr.id = p_professional_id and pr.business_id = p_business_id
  ) then
    raise exception 'Profissional não encontrado.' using errcode = 'AG422';
  end if;
  if jsonb_typeof(p_hours) is distinct from 'array' or jsonb_array_length(p_hours) > 70 then
    raise exception 'Expediente inválido.' using errcode = 'AG422';
  end if;

  delete from public.working_hours
  where business_id = p_business_id and professional_id is not distinct from p_professional_id;

  for v_row in
    select (h ->> 'weekday')::integer as weekday,
           public.safe_time(h ->> 'start') as start_time,
           public.safe_time(h ->> 'end') as end_time
    from jsonb_array_elements(p_hours) as h
  loop
    if v_row.weekday is null or v_row.weekday not between 0 and 6
       or v_row.start_time is null or v_row.end_time is null or v_row.end_time <= v_row.start_time then
      raise exception 'Horário inválido: o fim precisa ser depois do início.' using errcode = 'AG422';
    end if;
    if exists (
      select 1 from public.working_hours wh
      where wh.business_id = p_business_id and wh.professional_id is not distinct from p_professional_id
        and wh.weekday = v_row.weekday and wh.start_time < v_row.end_time and wh.end_time > v_row.start_time
    ) then
      raise exception 'Dois períodos do mesmo dia estão se sobrepondo.' using errcode = 'AG422';
    end if;
    insert into public.working_hours (business_id, professional_id, weekday, start_time, end_time)
    values (p_business_id, p_professional_id, v_row.weekday, v_row.start_time, v_row.end_time);
  end loop;
end;
$$;

-- Troca de uma vez os serviços que um profissional faz.
create function public.set_professional_services(p_professional_id uuid, p_service_ids uuid[])
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_business_id uuid;
begin
  select pr.business_id into v_business_id from public.professionals pr where pr.id = p_professional_id;
  perform public.require_owner(v_business_id);

  delete from public.professional_services where professional_id = p_professional_id;
  insert into public.professional_services (professional_id, service_id, business_id)
  select p_professional_id, s.id, v_business_id
  from public.services s
  where s.business_id = v_business_id and s.id = any (coalesce(p_service_ids, '{}'::uuid[]));
end;
$$;

-- Clientes com histórico resumido: atendimentos, faltas, cancelamentos e último atendimento.
create function public.owner_customers(p_business_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform public.require_owner(p_business_id);
  return coalesce((
    select jsonb_agg(to_jsonb(r) order by r.last_visit_at desc nulls last, r.name)
    from (
      select c.id, c.name, c.phone, c.notes, c.created_at,
             count(a.id) filter (where a.status = 'completed') as completed,
             count(a.id) filter (where a.status = 'no_show') as no_shows,
             count(a.id) filter (where a.status = 'canceled') as canceled,
             count(a.id) filter (where a.status in ('pending', 'confirmed') and a.starts_at > now()) as upcoming,
             -- Último atendimento: concluído, ou em aberto que já passou e ainda não recebeu baixa.
             max(a.starts_at) filter (
               where a.status = 'completed' or (a.status in ('pending', 'confirmed') and a.starts_at <= now())
             ) as last_visit_at,
             min(a.starts_at) filter (where a.status in ('pending', 'confirmed') and a.starts_at > now()) as next_at,
             coalesce(sum(a.price_cents) filter (where a.status = 'completed'), 0) as spent_cents,
             mode() within group (order by a.service_name) filter (where a.status in ('completed', 'confirmed', 'pending')) as favorite_service
      from public.customers c
      left join public.appointments a on a.customer_id = c.id
      where c.business_id = p_business_id
      group by c.id
    ) r
  ), '[]'::jsonb);
end;
$$;

-- ---------------------------------------------------------------------------
-- Row Level Security e privilégios
-- ---------------------------------------------------------------------------

alter table public.businesses enable row level security;
alter table public.services enable row level security;
alter table public.professionals enable row level security;
alter table public.professional_services enable row level security;
alter table public.working_hours enable row level security;
alter table public.blocks enable row level security;
alter table public.customers enable row level security;
alter table public.appointments enable row level security;
alter table public.rate_limits enable row level security;

-- O Supabase concede tudo a anon e authenticated por padrão; aqui começa do zero.
revoke all on public.businesses, public.services, public.professionals, public.professional_services,
  public.working_hours, public.blocks, public.customers, public.appointments, public.rate_limits
  from anon, authenticated;

-- Vitrine pública: estabelecimento, serviços, profissionais e expediente.
grant select on public.businesses, public.services, public.professionals,
  public.professional_services, public.working_hours to anon, authenticated;

create policy "businesses are public" on public.businesses for select using (true);
create policy "services are public" on public.services for select using (true);
create policy "professionals are public" on public.professionals for select using (true);
create policy "professional services are public" on public.professional_services for select using (true);
create policy "working hours are public" on public.working_hours for select using (true);

-- Estabelecimento: nasce por create_business; o dono só altera marca e regras (nunca dono ou id).
grant update (
  slug, name, description, booking_notice, phone, address, logo_url, primary_color, is_accepting,
  auto_confirm, choose_professional, slot_step_minutes, min_notice_minutes, max_advance_days,
  cancel_notice_minutes, ai_enabled
) on public.businesses to authenticated;
create policy "owner updates business" on public.businesses for update to authenticated
  using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()));

-- Serviços e profissionais: o dono cadastra direto.
grant insert, update, delete on public.services, public.professionals to authenticated;
create policy "owner inserts services" on public.services for insert to authenticated
  with check (public.is_business_owner(business_id));
create policy "owner updates services" on public.services for update to authenticated
  using (public.is_business_owner(business_id)) with check (public.is_business_owner(business_id));
create policy "owner deletes services" on public.services for delete to authenticated
  using (public.is_business_owner(business_id));

create policy "owner inserts professionals" on public.professionals for insert to authenticated
  with check (public.is_business_owner(business_id));
create policy "owner updates professionals" on public.professionals for update to authenticated
  using (public.is_business_owner(business_id)) with check (public.is_business_owner(business_id));
create policy "owner deletes professionals" on public.professionals for delete to authenticated
  using (public.is_business_owner(business_id));

-- Bloqueios: o dono lê e apaga; cria por owner_create_block (que converte o fuso).
grant select, delete on public.blocks to authenticated;
create policy "owner reads blocks" on public.blocks for select to authenticated
  using (public.is_business_owner(business_id));
create policy "owner deletes blocks" on public.blocks for delete to authenticated
  using (public.is_business_owner(business_id));

-- Clientes: só o dono. O cadastro nasce junto com o agendamento.
grant select, delete on public.customers to authenticated;
grant update (name, notes) on public.customers to authenticated;
create policy "owner reads customers" on public.customers for select to authenticated
  using (public.is_business_owner(business_id));
create policy "owner updates customers" on public.customers for update to authenticated
  using (public.is_business_owner(business_id)) with check (public.is_business_owner(business_id));
create policy "owner deletes customers" on public.customers for delete to authenticated
  using (public.is_business_owner(business_id));

-- Agendamentos: o dono só lê pela tabela (é o que alimenta o tempo real). Toda escrita passa
-- pelas funções, que aplicam as regras. Anônimo não tem acesso nenhum.
grant select on public.appointments to authenticated;
create policy "owner reads appointments" on public.appointments for select to authenticated
  using (public.is_business_owner(business_id));

-- Funções: nenhuma é pública por padrão; só as listadas abaixo.
revoke execute on all functions in schema public from public, anon, authenticated;

grant execute on function
  public.get_availability(uuid, uuid, uuid, date, integer, uuid),
  public.book_appointment(jsonb),
  public.get_appointment(uuid),
  public.cancel_appointment(uuid, text),
  public.reschedule_appointment(uuid, timestamptz, uuid),
  -- usada pelas políticas de RLS acima
  public.is_business_owner(uuid)
to anon, authenticated;

grant execute on function
  public.create_business(jsonb),
  public.owner_agenda(uuid, date, date),
  public.owner_availability(uuid, uuid, uuid, date, uuid),
  public.owner_create_appointment(jsonb),
  public.owner_set_appointment_status(uuid, text, text),
  public.owner_reschedule_appointment(jsonb),
  public.owner_create_block(uuid, uuid, date, time, date, time, text),
  public.set_working_hours(uuid, uuid, jsonb),
  public.set_professional_services(uuid, uuid[]),
  public.owner_customers(uuid)
to authenticated;

-- Painel em tempo real.
alter publication supabase_realtime add table public.appointments;

-- ---------------------------------------------------------------------------
-- Logotipos: bucket público de leitura; só o dono grava na pasta do próprio estabelecimento.
-- ---------------------------------------------------------------------------

do $$
begin
  if exists (select 1 from information_schema.tables where table_schema = 'storage' and table_name = 'buckets') then
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values ('marcas', 'marcas', true, 2097152, array['image/jpeg', 'image/png', 'image/webp'])
    on conflict (id) do nothing;

    execute $p$create policy "marcas: leitura publica" on storage.objects for select
      using (bucket_id = 'marcas')$p$;
    execute $p$create policy "marcas: dono envia" on storage.objects for insert to authenticated
      with check (bucket_id = 'marcas' and exists (
        select 1 from public.businesses b
        where b.id::text = (storage.foldername(name))[1] and b.owner_id = (select auth.uid())))$p$;
    execute $p$create policy "marcas: dono troca" on storage.objects for update to authenticated
      using (bucket_id = 'marcas' and exists (
        select 1 from public.businesses b
        where b.id::text = (storage.foldername(name))[1] and b.owner_id = (select auth.uid())))$p$;
    execute $p$create policy "marcas: dono apaga" on storage.objects for delete to authenticated
      using (bucket_id = 'marcas' and exists (
        select 1 from public.businesses b
        where b.id::text = (storage.foldername(name))[1] and b.owner_id = (select auth.uid())))$p$;
  end if;
end;
$$;
