-- Teste das regras de agenda, de fuso e de permissão (rode num banco com as migrações aplicadas).
-- psql -v ON_ERROR_STOP=1 -f supabase/tests/agenda.sql
-- Tudo acontece dentro de uma transação desfeita no final: não deixa dados no banco.
begin;

-- Executa um comando e diz se ele falhou com o código esperado.
create function pg_temp.raises(p_sql text, p_state text)
returns boolean
language plpgsql
as $$
begin
  execute p_sql;
  raise notice 'esperava erro %, mas o comando passou: %', p_state, p_sql;
  return false;
exception when others then
  if sqlstate = p_state then
    return true;
  end if;
  raise notice 'esperava erro %, veio % (%): %', p_state, sqlstate, sqlerrm, p_sql;
  return false;
end;
$$;

-- Horas ("HH:MI") livres de um dia, na visão do cliente.
create function pg_temp.times(p_business uuid, p_service uuid, p_professional uuid, p_day date)
returns text[]
language sql
as $$
  select coalesce(array_agg(s ->> 'time' order by s ->> 'at'), '{}')
  from jsonb_array_elements(public.get_availability(p_business, p_service, p_professional, p_day, 1) -> 'days') d,
       jsonb_array_elements(d -> 'slots') s
  where d ->> 'date' = p_day::text;
$$;

create function pg_temp.login(p_user uuid)
returns void
language sql
as $$
  select set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
$$;

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000a1', 'dona-clinica@teste.local'),
  ('00000000-0000-0000-0000-0000000000a2', 'dono-salao@teste.local'),
  ('00000000-0000-0000-0000-0000000000a3', 'sem-estabelecimento@teste.local');

-- ---------------------------------------------------------------------------
-- 1. Criação com modelo por segmento
-- ---------------------------------------------------------------------------
select pg_temp.login('00000000-0000-0000-0000-0000000000a1');
select public.create_business('{"name": "Clínica Teste", "slug": "clinica-teste", "segment": "clinica",
  "phone": "(11) 98888-7777", "professional_name": "Dra. Ana"}'::jsonb);
select pg_temp.login('00000000-0000-0000-0000-0000000000a2');
select public.create_business('{"name": "Salão Teste", "slug": "salao-teste", "segment": "salao"}'::jsonb);

do $$
declare
  v_a uuid := (select id from public.businesses where slug = 'clinica-teste');
  v_b uuid := (select id from public.businesses where slug = 'salao-teste');
begin
  assert (select count(*) from public.services where business_id = v_a) = 3, 'clínica: 3 serviços do modelo';
  assert (select count(*) from public.working_hours where business_id = v_a) = 10, 'clínica: 10 períodos (manhã e tarde, seg a sex)';
  assert (select count(*) from public.professionals where business_id = v_a and name = 'Dra. Ana') = 1, 'primeiro profissional';
  assert (select count(*) from public.professional_services where business_id = v_a) = 3, 'profissional ligado a todos os serviços';
  assert (select not auto_confirm and phone = '11988887777' and primary_color = '#0f766e' from public.businesses where id = v_a),
    'regras e telefone do modelo de clínica';
  assert (select count(*) from public.services where business_id = v_b) = 12, 'salão: 12 serviços do modelo';
  assert (select auto_confirm and name = 'Salão Teste' from public.businesses where id = v_b), 'salão confirma sozinho';
  assert (select name from public.professionals where business_id = v_b) = 'Profissional 1', 'nome padrão do profissional';

  -- Endereço reservado, repetido e segundo estabelecimento na mesma conta.
  perform pg_temp.login('00000000-0000-0000-0000-0000000000a3');
  assert pg_temp.raises($q$select public.create_business('{"name": "Xis", "slug": "painel", "segment": "salao"}')$q$, 'AG422'), 'slug reservado';
  assert pg_temp.raises($q$select public.create_business('{"name": "Xis", "slug": "Salão!", "segment": "salao"}')$q$, 'AG422'), 'slug inválido';
  assert pg_temp.raises($q$select public.create_business('{"name": "Xis", "slug": "salao-teste", "segment": "salao"}')$q$, 'AG409'), 'slug repetido';
  assert pg_temp.raises($q$select public.create_business('{"name": "Xis", "slug": "xis-bronze", "segment": "padaria"}')$q$, 'AG422'), 'segmento inválido';
  perform pg_temp.login('00000000-0000-0000-0000-0000000000a1');
  assert pg_temp.raises($q$select public.create_business('{"name": "Outra", "slug": "outra-clinica", "segment": "clinica"}')$q$, 'AG409'), 'um estabelecimento por conta';
  perform set_config('request.jwt.claims', '', true);
  assert pg_temp.raises($q$select public.create_business('{"name": "Anon", "slug": "anonimo", "segment": "salao"}')$q$, 'AG401'), 'criar exige login';
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. Telefone
-- ---------------------------------------------------------------------------
do $$
begin
  assert public.normalize_phone('(11) 99999-8888') = '11999998888', 'celular com máscara';
  assert public.normalize_phone('+55 11 99999-8888') = '11999998888', 'celular com +55';
  assert public.normalize_phone('5511999998888') = '11999998888', 'celular com 55';
  assert public.normalize_phone('1133334444') = '1133334444', 'fixo com DDD';
  assert public.normalize_phone('99999-8888') is null, 'sem DDD';
  assert public.normalize_phone('011999998888') is null, 'DDD começando em zero';
  assert public.normalize_phone('') is null and public.normalize_phone(null) is null, 'vazio';
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. Horário livre: expediente, intervalo, duração, bloqueio, antecedência, janela
-- ---------------------------------------------------------------------------
do $$
declare
  v_a uuid := (select id from public.businesses where slug = 'clinica-teste');
  v_consulta uuid := (select id from public.services where business_id = v_a and name = 'Consulta');          -- 30 min
  v_avaliacao uuid := (select id from public.services where business_id = v_a and name = 'Avaliação inicial'); -- 40 min
  v_ana uuid := (select id from public.professionals where business_id = v_a);
  v_today date := public.local_today();
  -- Uma segunda-feira com pelo menos 8 dias de folga, para a antecedência mínima não atrapalhar.
  v_mon date := v_today + 8 + ((1 - extract(dow from v_today + 8)::integer + 7) % 7);
  v_times text[];
  v_block uuid;
  v_r jsonb;
begin
  assert extract(dow from v_mon) = 1, 'a data de teste é uma segunda';

  -- Expediente da clínica: 08-12 e 13-18. Consulta de 30 min: 8 horários de manhã + 10 à tarde.
  v_times := pg_temp.times(v_a, v_consulta, null, v_mon);
  assert array_length(v_times, 1) = 18, 'consulta: 18 horários, vieram ' || coalesce(array_length(v_times, 1), 0);
  assert v_times[1] = '08:00' and v_times[8] = '11:30' and v_times[9] = '13:00' and v_times[18] = '17:30',
    'consulta: primeiro e último de cada período: ' || v_times::text;
  assert not ('12:00' = any (v_times)) and not ('12:30' = any (v_times)), 'nada no intervalo do almoço';

  -- Avaliação de 40 min precisa caber antes do fim do período: 11:00 cabe (termina 11:40), 11:30 não.
  v_times := pg_temp.times(v_a, v_avaliacao, null, v_mon);
  assert array_length(v_times, 1) = 16, 'avaliação: 16 horários, vieram ' || coalesce(array_length(v_times, 1), 0);
  assert '11:00' = any (v_times) and not ('11:30' = any (v_times)), 'avaliação não invade o almoço';
  assert '17:00' = any (v_times) and not ('17:30' = any (v_times)), 'avaliação não passa do fechamento';

  -- Domingo fechado; escolher o profissional dá o mesmo resultado quando só há um.
  assert pg_temp.times(v_a, v_consulta, null, v_mon - 1) = '{}', 'domingo sem horários';
  assert pg_temp.times(v_a, v_consulta, v_ana, v_mon) = pg_temp.times(v_a, v_consulta, null, v_mon), 'profissional escolhido';

  -- Bloqueio da casa das 09:00 às 10:00: somem 09:00 e 09:30; 08:30 (termina 09:00) e 10:00 ficam.
  perform pg_temp.login('00000000-0000-0000-0000-0000000000a1');
  v_r := public.owner_create_block(v_a, null, v_mon, '09:00', v_mon, '10:00', 'Reunião');
  v_block := (v_r ->> 'id')::uuid;
  v_times := pg_temp.times(v_a, v_consulta, null, v_mon);
  assert not ('09:00' = any (v_times)) and not ('09:30' = any (v_times)), 'bloqueio tira os horários';
  assert '08:30' = any (v_times) and '10:00' = any (v_times), 'horários encostados no bloqueio ficam';
  -- Avaliação às 08:30 terminaria 09:10, dentro do bloqueio.
  assert not ('08:30' = any (pg_temp.times(v_a, v_avaliacao, null, v_mon))), 'serviço longo não entra no bloqueio';
  delete from public.blocks where id = v_block;

  -- Bloqueio só da profissional (folga do dia inteiro, atravessando a meia-noite).
  v_r := public.owner_create_block(v_a, v_ana, v_mon, '00:00', v_mon + 1, '00:00', 'Folga');
  assert pg_temp.times(v_a, v_consulta, null, v_mon) = '{}', 'folga da única profissional zera o dia';
  assert array_length(pg_temp.times(v_a, v_consulta, null, v_mon + 1), 1) = 18, 'o dia seguinte não é afetado';
  delete from public.blocks where id = (v_r ->> 'id')::uuid;
  assert pg_temp.raises(format($q$select public.owner_create_block(%L, null, %L, '10:00', %L, '09:00')$q$, v_a, v_mon, v_mon), 'AG422'),
    'bloqueio com fim antes do início';

  -- Antecedência mínima: com 7 dias, amanhã e depois não têm horário; a segunda de teste tem.
  update public.businesses set min_notice_minutes = 10080 where id = v_a;
  assert (select count(*) from jsonb_array_elements(public.get_availability(v_a, v_consulta, null, v_today, 7) -> 'days')) = 0,
    'antecedência de 7 dias esvazia a semana';
  assert array_length(pg_temp.times(v_a, v_consulta, null, v_mon), 1) = 18, 'depois da antecedência há horários';
  update public.businesses set min_notice_minutes = 120 where id = v_a;

  -- Nenhum horário de hoje que já passou ou que esteja dentro da antecedência.
  assert not exists (
    select 1 from jsonb_array_elements(public.get_availability(v_a, v_consulta, null, v_today, 2) -> 'days') d,
                  jsonb_array_elements(d -> 'slots') s
    where (s ->> 'at')::timestamptz < now() + interval '120 minutes'
  ), 'nada antes de agora + antecedência';

  -- Janela máxima: com 10 dias, nada depois; a resposta diz o último dia.
  update public.businesses set max_advance_days = 10 where id = v_a;
  v_r := public.get_availability(v_a, v_consulta, null, v_today + 11, 14);
  assert jsonb_array_length(v_r -> 'days') = 0, 'nada além da janela';
  assert (v_r ->> 'last_date')::date = v_today + 10, 'último dia da janela';
  v_r := public.get_availability(v_a, v_consulta, null, v_today, 62);
  assert not exists (select 1 from jsonb_array_elements(v_r -> 'days') d where (d ->> 'date')::date > v_today + 10), 'janela corta o fim';
  update public.businesses set max_advance_days = 90 where id = v_a;

  -- Datas passadas são ignoradas: começa de hoje.
  v_r := public.get_availability(v_a, v_consulta, null, v_today - 30, 5);
  assert (v_r ->> 'from')::date = v_today, 'não olha para trás';

  -- Agenda online desligada: sem horários, e a resposta avisa.
  update public.businesses set is_accepting = false where id = v_a;
  v_r := public.get_availability(v_a, v_consulta, null, v_mon, 1);
  assert jsonb_array_length(v_r -> 'days') = 0 and not (v_r ->> 'accepting')::boolean, 'agenda desligada';
  update public.businesses set is_accepting = true where id = v_a;

  -- Serviço desativado ou de outro estabelecimento não tem horário.
  assert pg_temp.raises(format('select public.get_availability(%L, %L)', v_a,
    (select id from public.services where business_id <> v_a limit 1)), 'AG404'), 'serviço de outro estabelecimento';
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Agendar: preço e duração vêm do banco; o horário some; sobreposição nunca
-- ---------------------------------------------------------------------------
do $$
declare
  v_a uuid := (select id from public.businesses where slug = 'clinica-teste');
  v_consulta uuid := (select id from public.services where business_id = v_a and name = 'Consulta');
  v_avaliacao uuid := (select id from public.services where business_id = v_a and name = 'Avaliação inicial');
  v_ana uuid := (select id from public.professionals where business_id = v_a);
  v_bia uuid;
  v_today date := public.local_today();
  v_mon date := v_today + 8 + ((1 - extract(dow from v_today + 8)::integer + 7) % 7);
  v_r jsonb;
  v_row public.appointments%rowtype;
  v_token uuid;
  v_times text[];
  v_customer uuid;
begin
  perform set_config('request.jwt.claims', '', true);

  -- O cliente tenta mandar preço, duração e situação: nada disso é aceito.
  v_r := public.book_appointment(jsonb_build_object(
    'business_id', v_a, 'service_id', v_consulta, 'starts_at', public.local_ts(v_mon, '09:00'),
    'customer_name', '  Maria   da Silva ', 'customer_phone', '(11) 99999-0001',
    'price_cents', 1, 'duration_minutes', 5, 'status', 'completed', 'notes', ' primeira vez '));
  v_token := (v_r ->> 'token')::uuid;
  select * into v_row from public.appointments where public_token = v_token;
  assert v_row.price_cents = 20000 and v_row.duration_minutes = 30, 'preço e duração do banco';
  assert v_row.status = 'pending', 'clínica: entra aguardando confirmação';
  assert v_row.ends_at = public.local_ts(v_mon, '09:30'), 'fim calculado';
  assert v_row.customer_name = 'Maria da Silva' and v_row.notes = 'primeira vez', 'texto aparado';
  assert v_row.professional_id = v_ana and v_row.source = 'web', 'profissional e origem';
  assert (v_r ->> 'time') = '09:00' and (v_r ->> 'date')::date = v_mon, 'resposta no relógio de São Paulo';
  assert (select phone from public.customers where id = v_row.customer_id) = '11999990001', 'telefone normalizado';

  -- O horário some; os vizinhos ficam; o serviço de 40 min não cabe mais às 08:30.
  v_times := pg_temp.times(v_a, v_consulta, null, v_mon);
  assert not ('09:00' = any (v_times)) and '08:30' = any (v_times) and '09:30' = any (v_times), 'só o horário ocupado some';
  assert not ('08:30' = any (pg_temp.times(v_a, v_avaliacao, null, v_mon))), 'avaliação das 08:30 bateria na consulta das 09:00';
  assert '08:00' = any (pg_temp.times(v_a, v_avaliacao, null, v_mon)), 'avaliação das 08:00 termina 08:40';

  -- Mesmo horário de novo: recusado. Horário fora da grade, passado ou inventado: recusado.
  assert pg_temp.raises(format($q$select public.book_appointment(%L)$q$, jsonb_build_object(
    'business_id', v_a, 'service_id', v_consulta, 'starts_at', public.local_ts(v_mon, '09:00'),
    'customer_name', 'João', 'customer_phone', '11999990002')), 'AG409'), 'horário já ocupado';
  assert pg_temp.raises(format($q$select public.book_appointment(%L)$q$, jsonb_build_object(
    'business_id', v_a, 'service_id', v_consulta, 'starts_at', public.local_ts(v_mon, '09:10'),
    'customer_name', 'João', 'customer_phone', '11999990002')), 'AG409'), 'fora da grade';
  assert pg_temp.raises(format($q$select public.book_appointment(%L)$q$, jsonb_build_object(
    'business_id', v_a, 'service_id', v_consulta, 'starts_at', public.local_ts(v_mon, '12:00'),
    'customer_name', 'João', 'customer_phone', '11999990002')), 'AG409'), 'no intervalo';
  assert pg_temp.raises(format($q$select public.book_appointment(%L)$q$, jsonb_build_object(
    'business_id', v_a, 'service_id', v_consulta, 'starts_at', now() - interval '1 day',
    'customer_name', 'João', 'customer_phone', '11999990002')), 'AG409'), 'no passado';
  assert pg_temp.raises(format($q$select public.book_appointment(%L)$q$, jsonb_build_object(
    'business_id', v_a, 'service_id', v_consulta, 'starts_at', public.local_ts(v_mon, '10:00'),
    'customer_name', 'J', 'customer_phone', '11999990002')), 'AG422'), 'nome curto';
  assert pg_temp.raises(format($q$select public.book_appointment(%L)$q$, jsonb_build_object(
    'business_id', v_a, 'service_id', v_consulta, 'starts_at', public.local_ts(v_mon, '10:00'),
    'customer_name', 'João', 'customer_phone', '9999')), 'AG422'), 'telefone inválido';
  assert pg_temp.raises(format($q$select public.book_appointment(%L)$q$, jsonb_build_object(
    'business_id', v_a, 'service_id', v_consulta, 'starts_at', 'amanhã cedo',
    'customer_name', 'João', 'customer_phone', '11999990002')), 'AG422'), 'horário ilegível';

  -- A trava do banco, sem passar pelas funções: sobrepor falha, encostar passa, cancelado não ocupa.
  select customer_id into v_customer from public.appointments where public_token = v_token;
  assert pg_temp.raises(format($q$insert into public.appointments
    (business_id, professional_id, customer_id, service_name, duration_minutes, price_cents, customer_name, starts_at, ends_at)
    values (%L, %L, %L, 'x', 30, 0, 'Teste', %L, %L)$q$,
    v_a, v_ana, v_customer, public.local_ts(v_mon, '09:15'), public.local_ts(v_mon, '09:45')), '23P01'), 'sobreposição parcial';
  assert pg_temp.raises(format($q$insert into public.appointments
    (business_id, professional_id, customer_id, service_name, duration_minutes, price_cents, customer_name, starts_at, ends_at)
    values (%L, %L, %L, 'x', 60, 0, 'Teste', %L, %L)$q$,
    v_a, v_ana, v_customer, public.local_ts(v_mon, '08:45'), public.local_ts(v_mon, '09:45')), '23P01'), 'sobreposição que engloba';
  insert into public.appointments
    (business_id, professional_id, customer_id, service_name, duration_minutes, price_cents, customer_name, starts_at, ends_at)
  values (v_a, v_ana, v_customer, 'encostado', 30, 0, 'Teste', public.local_ts(v_mon, '09:30'), public.local_ts(v_mon, '10:00'));
  insert into public.appointments
    (business_id, professional_id, customer_id, service_name, duration_minutes, price_cents, customer_name, starts_at, ends_at, status)
  values (v_a, v_ana, v_customer, 'cancelado', 30, 0, 'Teste', public.local_ts(v_mon, '09:00'), public.local_ts(v_mon, '09:30'), 'canceled'),
         (v_a, v_ana, v_customer, 'falta', 30, 0, 'Teste', public.local_ts(v_mon, '09:00'), public.local_ts(v_mon, '09:30'), 'no_show');
  -- Duração gravada tem de bater com início e fim.
  assert pg_temp.raises(format($q$insert into public.appointments
    (business_id, professional_id, customer_id, service_name, duration_minutes, price_cents, customer_name, starts_at, ends_at)
    values (%L, %L, %L, 'x', 30, 0, 'Teste', %L, %L)$q$,
    v_a, v_ana, v_customer, public.local_ts(v_mon, '15:00'), public.local_ts(v_mon, '16:00')), '23514'), 'duração incoerente';
  delete from public.appointments where service_name in ('encostado', 'cancelado', 'falta');

  -- "Qualquer profissional": segunda profissional só para Consulta. Dois clientes no mesmo horário
  -- ficam um com cada; o terceiro não cabe.
  insert into public.professionals (business_id, name, position) values (v_a, 'Dra. Bia', 2) returning id into v_bia;
  insert into public.professional_services (professional_id, service_id, business_id) values (v_bia, v_consulta, v_a);
  assert '09:00' = any (pg_temp.times(v_a, v_consulta, null, v_mon)), 'com a Bia, 09:00 volta a existir';
  assert not ('09:00' = any (pg_temp.times(v_a, v_consulta, v_ana, v_mon))), 'mas não com a Ana';
  v_r := public.book_appointment(jsonb_build_object(
    'business_id', v_a, 'service_id', v_consulta, 'starts_at', public.local_ts(v_mon, '09:00'),
    'customer_name', 'João', 'customer_phone', '11999990002'));
  assert (v_r ->> 'professional_name') = 'Dra. Bia', 'qualquer um: foi para quem estava livre';
  assert pg_temp.raises(format($q$select public.book_appointment(%L)$q$, jsonb_build_object(
    'business_id', v_a, 'service_id', v_consulta, 'starts_at', public.local_ts(v_mon, '09:00'),
    'customer_name', 'Carla', 'customer_phone', '11999990003')), 'AG409'), 'terceiro no mesmo horário não cabe';
  -- Às 14:00 as duas estão livres e empatadas em um agendamento cada: vale a ordem do cadastro (Ana).
  v_r := public.book_appointment(jsonb_build_object(
    'business_id', v_a, 'service_id', v_consulta, 'starts_at', public.local_ts(v_mon, '14:00'),
    'customer_name', 'Carla', 'customer_phone', '11999990003'));
  assert (v_r ->> 'professional_name') = 'Dra. Ana', 'empate: ordem do cadastro';
  -- Agora a Ana tem dois e a Bia um: o próximo vai para a Bia.
  v_r := public.book_appointment(jsonb_build_object(
    'business_id', v_a, 'service_id', v_consulta, 'starts_at', public.local_ts(v_mon, '15:00'),
    'customer_name', 'Davi', 'customer_phone', '11999990004'));
  assert (v_r ->> 'professional_name') = 'Dra. Bia', 'qualquer um: dia mais vazio primeiro';
  -- Avaliação a Bia não faz: pedir com ela não encontra horário.
  assert pg_temp.raises(format($q$select public.book_appointment(%L)$q$, jsonb_build_object(
    'business_id', v_a, 'service_id', v_avaliacao, 'professional_id', v_bia, 'starts_at', public.local_ts(v_mon, '16:00'),
    'customer_name', 'Davi', 'customer_phone', '11999990004')), 'AG409'), 'profissional que não faz o serviço';

  -- Mesmo telefone, nome diferente: um cadastro só; o nome do agendamento é o informado.
  v_r := public.book_appointment(jsonb_build_object(
    'business_id', v_a, 'service_id', v_consulta, 'starts_at', public.local_ts(v_mon, '16:00'),
    'customer_name', 'Filha da Maria', 'customer_phone', '11 99999-0001'));
  assert (select count(*) from public.customers where business_id = v_a and phone = '11999990001') = 1, 'um cadastro por telefone';
  assert (select name from public.customers where business_id = v_a and phone = '11999990001') = 'Maria da Silva', 'cadastro mantém o primeiro nome';
  assert (select customer_name from public.appointments where public_token = (v_r ->> 'token')::uuid) = 'Filha da Maria', 'nome do agendamento';

  -- Agenda online desligada recusa novo agendamento.
  update public.businesses set is_accepting = false where id = v_a;
  assert pg_temp.raises(format($q$select public.book_appointment(%L)$q$, jsonb_build_object(
    'business_id', v_a, 'service_id', v_consulta, 'starts_at', public.local_ts(v_mon, '17:00'),
    'customer_name', 'Eva', 'customer_phone', '11999990005')), 'AG403'), 'agenda desligada';
  update public.businesses set is_accepting = true where id = v_a;
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. Link secreto: ver, cancelar e remarcar dentro da regra
-- ---------------------------------------------------------------------------
do $$
declare
  v_a uuid := (select id from public.businesses where slug = 'clinica-teste');
  v_consulta uuid := (select id from public.services where business_id = v_a and name = 'Consulta');
  v_ana uuid := (select id from public.professionals where business_id = v_a and name = 'Dra. Ana');
  v_bia uuid := (select id from public.professionals where business_id = v_a and name = 'Dra. Bia');
  v_today date := public.local_today();
  v_mon date := v_today + 8 + ((1 - extract(dow from v_today + 8)::integer + 7) % 7);
  v_token uuid := (select a.public_token from public.appointments a join public.customers c on c.id = a.customer_id
                   where c.phone = '11999990001' and a.customer_name = 'Maria da Silva');
  v_soon uuid;
  v_r jsonb;
begin
  perform set_config('request.jwt.claims', '', true);

  v_r := public.get_appointment(v_token);
  assert (v_r ->> 'time') = '09:00' and (v_r ->> 'end_time') = '09:30' and (v_r ->> 'date')::date = v_mon, 'horas de São Paulo';
  assert (v_r ->> 'can_change')::boolean, 'longe do horário: pode mudar';
  assert not (v_r ? 'customer_phone') and v_r::text not like '%11999990001%', 'o link não devolve telefone';
  assert (v_r -> 'business' ->> 'name') = 'Clínica Teste', 'marca do estabelecimento';
  assert public.get_appointment(gen_random_uuid()) is null, 'token desconhecido não acha nada';

  -- Remarcar para as 11:00: mantém a profissional, libera as 09:00, volta a aguardar confirmação.
  update public.appointments set status = 'confirmed' where public_token = v_token;
  v_r := public.reschedule_appointment(v_token, public.local_ts(v_mon, '11:00'));
  assert (v_r ->> 'time') = '11:00' and (v_r ->> 'professional_id')::uuid = v_ana and (v_r ->> 'status') = 'pending', 'remarcado';
  assert '09:00' = any (pg_temp.times(v_a, v_consulta, v_ana, v_mon)), 'o horário antigo foi liberado';
  assert not ('11:00' = any (pg_temp.times(v_a, v_consulta, v_ana, v_mon))), 'o novo está ocupado';
  -- Na tela de remarcar (com o token) o próprio horário aparece como livre.
  assert exists (
    select 1 from jsonb_array_elements(public.get_availability(v_a, v_consulta, v_ana, v_mon, 1, v_token) -> 'days') d,
                  jsonb_array_elements(d -> 'slots') s where s ->> 'time' = '11:00'
  ), 'remarcando, o próprio horário não conta como ocupado';

  -- Remarcar para onde a Ana está ocupada (14:00) cai com a Bia, que está livre.
  v_r := public.reschedule_appointment(v_token, public.local_ts(v_mon, '14:00'));
  assert (v_r ->> 'professional_id')::uuid = v_bia, 'remarcar: troca de profissional quando a atual está ocupada';
  -- Pedindo a Ana às 14:00, onde ela está ocupada: recusa.
  assert pg_temp.raises(format('select public.reschedule_appointment(%L, %L, %L)', v_token, public.local_ts(v_mon, '14:00'), v_ana), 'AG409'),
    'remarcar para horário ocupado';
  assert pg_temp.raises(format('select public.reschedule_appointment(%L, %L)', v_token, public.local_ts(v_mon, '14:00')), 'AG422'),
    'remarcar para o mesmo horário';

  -- Cancelar: libera o horário; repetir é inofensivo; cancelado não remarca.
  v_r := public.cancel_appointment(v_token, '  imprevisto  ');
  assert (select status = 'canceled' and canceled_by = 'customer' and cancel_reason = 'imprevisto' and canceled_at is not null
          from public.appointments where public_token = v_token), 'cancelado pelo cliente';
  assert (public.cancel_appointment(v_token) ->> 'status') = 'canceled', 'cancelar de novo não dá erro';
  assert pg_temp.raises(format('select public.reschedule_appointment(%L, %L)', v_token, public.local_ts(v_mon, '11:30')), 'AG409'),
    'cancelado não remarca';
  assert not (public.get_appointment(v_token) ->> 'can_change')::boolean, 'cancelado não pode mudar';

  -- Prazo: a clínica exige 24 h. Um agendamento para daqui a 3 horas (encaixado pelo dono) não
  -- pode ser cancelado nem remarcado pelo link.
  perform pg_temp.login('00000000-0000-0000-0000-0000000000a1');
  v_r := public.owner_create_appointment(jsonb_build_object(
    'business_id', v_a, 'service_id', v_consulta, 'professional_id', v_ana,
    'starts_at', date_trunc('hour', now()) + interval '3 hours', 'force', true,
    'customer_name', 'Encaixe', 'customer_phone', '11999990009'));
  v_soon := (v_r ->> 'public_token')::uuid;
  perform set_config('request.jwt.claims', '', true);
  assert not (public.get_appointment(v_soon) ->> 'can_change')::boolean, 'dentro do prazo: não pode mudar';
  assert pg_temp.raises(format('select public.cancel_appointment(%L)', v_soon), 'AG403'), 'cancelar fora do prazo';
  assert pg_temp.raises(format('select public.reschedule_appointment(%L, %L)', v_soon, public.local_ts(v_mon, '11:30')), 'AG403'),
    'remarcar fora do prazo';
  assert (select status from public.appointments where public_token = v_soon) = 'confirmed', 'continua de pé';
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. Fuso e virada de dia
-- ---------------------------------------------------------------------------
do $$
declare
  v_a uuid := (select id from public.businesses where slug = 'clinica-teste');
  v_consulta uuid := (select id from public.services where business_id = v_a and name = 'Consulta');
  v_ana uuid := (select id from public.professionals where business_id = v_a and name = 'Dra. Ana');
  v_today date := public.local_today();
  v_mon date := v_today + 8 + ((1 - extract(dow from v_today + 8)::integer + 7) % 7);
  v_r jsonb;
  v_slot jsonb;
  v_late jsonb;
begin
  -- Meia-noite de São Paulo são 03:00 em UTC.
  assert public.local_ts('2026-11-24', '00:00') = '2026-11-24 03:00:00+00'::timestamptz, 'meia-noite de SP em UTC';
  assert public.local_ts('2026-11-24', '21:00') = '2026-11-25 00:00:00+00'::timestamptz, '21h de SP já é o dia seguinte em UTC';

  -- Expediente noturno na segunda: 20:00 às 23:30. O horário das 21:00 pertence à segunda de SP,
  -- embora em UTC já seja terça.
  perform pg_temp.login('00000000-0000-0000-0000-0000000000a1');
  perform public.set_working_hours(v_a, null, jsonb_build_array(
    jsonb_build_object('weekday', 1, 'start', '20:00', 'end', '23:30')));
  v_r := public.get_availability(v_a, v_consulta, v_ana, v_mon, 2);
  assert jsonb_array_length(v_r -> 'days') = 1 and (v_r -> 'days' -> 0 ->> 'date')::date = v_mon, 'tudo cai na segunda de SP';
  select s into v_slot from jsonb_array_elements(v_r -> 'days' -> 0 -> 'slots') s where s ->> 'time' = '21:00';
  assert (v_slot ->> 'at')::timestamptz = (v_mon + 1)::timestamp at time zone 'UTC', '21:00 de SP = 00:00 UTC do dia seguinte';
  assert (select array_agg(s ->> 'time' order by s ->> 'at') from jsonb_array_elements(v_r -> 'days' -> 0 -> 'slots') s)
    = array['20:00', '20:30', '21:00', '21:30', '22:00', '22:30', '23:00'], 'grade noturna';

  -- Agendar às 23:00: aparece na agenda da segunda, não na de terça.
  perform set_config('request.jwt.claims', '', true);
  v_late := public.book_appointment(jsonb_build_object(
    'business_id', v_a, 'service_id', v_consulta, 'professional_id', v_ana,
    'starts_at', (select s ->> 'at' from jsonb_array_elements(v_r -> 'days' -> 0 -> 'slots') s where s ->> 'time' = '23:00'),
    'customer_name', 'Noturno', 'customer_phone', '11999990010'));
  assert (v_late ->> 'date')::date = v_mon and (v_late ->> 'time') = '23:00', 'resposta no dia de SP';
  perform pg_temp.login('00000000-0000-0000-0000-0000000000a1');
  assert exists (select 1 from jsonb_array_elements(public.owner_agenda(v_a, v_mon, v_mon) -> 'appointments') a
                 where a ->> 'customer_name' = 'Noturno' and a ->> 'time' = '23:00' and (a ->> 'date')::date = v_mon), 'na agenda da segunda';
  assert not exists (select 1 from jsonb_array_elements(public.owner_agenda(v_a, v_mon + 1, v_mon + 1) -> 'appointments') a
                     where a ->> 'customer_name' = 'Noturno'), 'não na agenda da terça';

  -- Dono digitando data e hora de SP: mesma conversão.
  v_r := public.owner_create_appointment(jsonb_build_object(
    'business_id', v_a, 'service_id', v_consulta, 'professional_id', v_ana,
    'date', v_mon, 'time', '22:00', 'customer_name', 'Digitado', 'customer_phone', '11999990011'));
  assert (v_r ->> 'starts_at')::timestamptz = public.local_ts(v_mon, '22:00') and (v_r ->> 'time') = '22:00', 'data e hora digitadas';

  -- Volta o expediente da clínica.
  perform public.set_working_hours(v_a, null, (
    select jsonb_agg(jsonb_build_object('weekday', d, 'start', p.s, 'end', p.e))
    from generate_series(1, 5) d, (values ('08:00', '12:00'), ('13:00', '18:00')) as p(s, e)));
  assert (select count(*) from public.working_hours where business_id = v_a and professional_id is null) = 10, 'expediente restaurado';
  assert pg_temp.raises(format($q$select public.set_working_hours(%L, null, '[{"weekday":1,"start":"09:00","end":"12:00"},{"weekday":1,"start":"11:00","end":"15:00"}]')$q$, v_a), 'AG422'),
    'períodos sobrepostos';
  assert (select count(*) from public.working_hours where business_id = v_a and professional_id is null) = 10, 'erro não apaga o expediente';
end;
$$;

-- ---------------------------------------------------------------------------
-- 7. Painel: agendamento manual, situações, remarcar, expediente próprio, clientes
-- ---------------------------------------------------------------------------
do $$
declare
  v_a uuid := (select id from public.businesses where slug = 'clinica-teste');
  v_consulta uuid := (select id from public.services where business_id = v_a and name = 'Consulta');
  v_avaliacao uuid := (select id from public.services where business_id = v_a and name = 'Avaliação inicial');
  v_ana uuid := (select id from public.professionals where business_id = v_a and name = 'Dra. Ana');
  v_bia uuid := (select id from public.professionals where business_id = v_a and name = 'Dra. Bia');
  v_today date := public.local_today();
  v_mon date := v_today + 8 + ((1 - extract(dow from v_today + 8)::integer + 7) % 7);
  v_tue date := v_mon + 1;
  v_r jsonb;
  v_id uuid;
  v_other uuid;
  v_past uuid;
  v_customer uuid;
begin
  perform pg_temp.login('00000000-0000-0000-0000-0000000000a1');

  -- Fora do expediente só com "encaixe"; a Bia não faz Avaliação.
  assert pg_temp.raises(format($q$select public.owner_create_appointment(%L)$q$, jsonb_build_object(
    'business_id', v_a, 'service_id', v_consulta, 'professional_id', v_ana, 'date', v_tue, 'time', '19:00',
    'customer_name', 'Tarde', 'customer_phone', '11999990020')), 'AG409'), 'fora do expediente sem encaixe';
  assert pg_temp.raises(format($q$select public.owner_create_appointment(%L)$q$, jsonb_build_object(
    'business_id', v_a, 'service_id', v_avaliacao, 'professional_id', v_bia, 'date', v_tue, 'time', '09:00',
    'customer_name', 'Tarde', 'customer_phone', '11999990020')), 'AG422'), 'profissional que não faz o serviço';
  v_r := public.owner_create_appointment(jsonb_build_object(
    'business_id', v_a, 'service_id', v_consulta, 'professional_id', v_ana, 'date', v_tue, 'time', '19:00', 'force', true,
    'customer_name', 'Tarde', 'customer_phone', '11999990020'));
  v_id := (v_r ->> 'id')::uuid;
  assert (v_r ->> 'status') = 'confirmed' and (v_r ->> 'source') = 'panel' and (v_r ->> 'customer_phone') = '11999990020', 'agendamento do painel';
  -- Nem com encaixe dois ocupam a mesma profissional.
  assert pg_temp.raises(format($q$select public.owner_create_appointment(%L)$q$, jsonb_build_object(
    'business_id', v_a, 'service_id', v_consulta, 'professional_id', v_ana, 'date', v_tue, 'time', '19:15', 'force', true,
    'customer_name', 'Outro', 'customer_phone', '11999990021')), 'AG409'), 'encaixe não sobrepõe';

  -- Situações: não conclui nem marca falta antes da hora; cancela; reativa.
  assert pg_temp.raises(format('select public.owner_set_appointment_status(%L, %L)', v_id, 'completed'), 'AG409'), 'concluir antes da hora';
  assert pg_temp.raises(format('select public.owner_set_appointment_status(%L, %L)', v_id, 'no_show'), 'AG409'), 'falta antes da hora';
  assert pg_temp.raises(format('select public.owner_set_appointment_status(%L, %L)', v_id, 'pending'), 'AG422'), 'situação inválida';
  v_r := public.owner_set_appointment_status(v_id, 'canceled', 'profissional doente');
  assert (v_r ->> 'status') = 'canceled' and (v_r ->> 'canceled_by') = 'business' and (v_r ->> 'cancel_reason') = 'profissional doente', 'cancelado pelo dono';
  -- Com o horário livre, outro cliente entra; reativar o primeiro esbarra na trava.
  v_r := public.owner_create_appointment(jsonb_build_object(
    'business_id', v_a, 'service_id', v_consulta, 'professional_id', v_ana, 'date', v_tue, 'time', '19:00', 'force', true,
    'customer_name', 'Outro', 'customer_phone', '11999990021'));
  v_other := (v_r ->> 'id')::uuid;
  assert pg_temp.raises(format('select public.owner_set_appointment_status(%L, %L)', v_id, 'confirmed'), 'AG409'), 'reativar em horário já ocupado';
  perform public.owner_set_appointment_status(v_other, 'canceled');
  v_r := public.owner_set_appointment_status(v_id, 'confirmed');
  assert (v_r ->> 'status') = 'confirmed' and v_r ->> 'cancel_reason' is null, 'reativado e sem motivo';

  -- Atendimento que já passou: concluir, desfazer, falta. Falta libera o horário; concluído não.
  v_r := public.owner_create_appointment(jsonb_build_object(
    'business_id', v_a, 'service_id', v_consulta, 'professional_id', v_bia,
    'starts_at', date_trunc('hour', now()) - interval '5 hours', 'force', true,
    'customer_name', 'Passado', 'customer_phone', '11999990022'));
  v_past := (v_r ->> 'id')::uuid;
  assert (v_r ->> 'is_past')::boolean, 'já passou';
  assert (public.owner_set_appointment_status(v_past, 'completed') ->> 'status') = 'completed', 'concluído';
  assert pg_temp.raises(format($q$select public.owner_create_appointment(%L)$q$, jsonb_build_object(
    'business_id', v_a, 'service_id', v_consulta, 'professional_id', v_bia,
    'starts_at', date_trunc('hour', now()) - interval '5 hours', 'force', true,
    'customer_name', 'Sobre', 'customer_phone', '11999990023')), 'AG409'), 'concluído continua ocupando o horário';
  assert pg_temp.raises(format('select public.owner_set_appointment_status(%L, %L)', v_past, 'canceled'), 'AG409'), 'concluído não cancela direto';
  assert (public.owner_set_appointment_status(v_past, 'no_show') ->> 'status') = 'no_show', 'falta';
  v_r := public.owner_create_appointment(jsonb_build_object(
    'business_id', v_a, 'service_id', v_consulta, 'professional_id', v_bia,
    'starts_at', date_trunc('hour', now()) - interval '5 hours', 'force', true,
    'customer_name', 'Sobre', 'customer_phone', '11999990023'));
  assert (v_r ->> 'status') = 'confirmed', 'falta libera o horário para encaixe';

  -- Remarcar pelo painel: dentro do expediente passa; ocupado ou fora só com encaixe; nunca sobrepõe.
  v_r := public.owner_reschedule_appointment(jsonb_build_object('appointment_id', v_id, 'date', v_tue, 'time', '10:00'));
  assert (v_r ->> 'time') = '10:00' and (v_r ->> 'professional_id')::uuid = v_ana, 'remarcado pelo dono';
  v_r := public.owner_reschedule_appointment(jsonb_build_object('appointment_id', v_id, 'date', v_tue, 'time', '10:30', 'professional_id', v_bia));
  assert (v_r ->> 'professional_id')::uuid = v_bia and (v_r ->> 'end_time') = '11:00', 'troca de profissional';
  assert pg_temp.raises(format($q$select public.owner_reschedule_appointment(%L)$q$,
    jsonb_build_object('appointment_id', v_id, 'date', v_tue, 'time', '12:15')), 'AG409'), 'no almoço sem encaixe';
  v_r := public.owner_reschedule_appointment(jsonb_build_object('appointment_id', v_id, 'date', v_tue, 'time', '12:15', 'force', true));
  assert (v_r ->> 'time') = '12:15', 'encaixe no almoço';
  assert pg_temp.raises(format($q$select public.owner_reschedule_appointment(%L)$q$,
    jsonb_build_object('appointment_id', v_other, 'date', v_tue, 'time', '09:00')), 'AG409'), 'cancelado não remarca';

  -- Lista de horários livres do dono: sem antecedência mínima, mas nunca no passado.
  assert not exists (select 1 from jsonb_array_elements(public.owner_availability(v_a, v_consulta, null, v_today)) s
                     where (s ->> 'at')::timestamptz <= now()), 'dono não vê horário que já passou';
  assert jsonb_array_length(public.owner_availability(v_a, v_consulta, v_ana, v_tue)) = 18, 'dia livre da Ana: 18 horários';

  -- Expediente próprio: a Bia passa a atender só terça de manhã; a casa não muda.
  update public.professionals set custom_hours = true where id = v_bia;
  perform public.set_working_hours(v_a, v_bia, '[{"weekday": 2, "start": "08:00", "end": "10:00"}]');
  assert pg_temp.times(v_a, v_consulta, v_bia, v_tue) = array['08:00', '08:30', '09:00', '09:30'], 'expediente próprio da Bia';
  assert pg_temp.times(v_a, v_consulta, v_bia, v_tue + 1) = '{}', 'quarta a Bia não atende';
  assert array_length(pg_temp.times(v_a, v_consulta, v_ana, v_tue + 1), 1) = 18, 'a Ana segue a casa';
  update public.professionals set custom_hours = false where id = v_bia;

  -- Profissional desativado some da agenda online; com agendamento não pode ser apagado.
  update public.professionals set is_active = false where id = v_bia;
  assert pg_temp.times(v_a, v_consulta, v_bia, v_tue + 1) = '{}', 'desativado não aparece';
  assert pg_temp.raises(format('delete from public.professionals where id = %L', v_bia), '23503'), 'profissional com agendamento não é apagado';
  update public.professionals set is_active = true where id = v_bia;

  -- Serviços de um profissional, de uma vez (ignora serviço de outro estabelecimento).
  perform public.set_professional_services(v_bia, array[v_avaliacao, (select id from public.services where business_id <> v_a limit 1)]);
  assert (select array_agg(service_id) from public.professional_services where professional_id = v_bia) = array[v_avaliacao], 'serviços trocados';
  perform public.set_professional_services(v_bia, array[v_consulta]);

  -- Apagar um serviço não apaga a história: o agendamento guarda nome, duração e preço.
  delete from public.services where id = v_avaliacao;
  assert (select count(*) from public.appointments where business_id = v_a and service_id is null) = 0, 'nenhum agendamento usava a avaliação';
  insert into public.services (business_id, name, duration_minutes, price_cents) values (v_a, 'Temporário', 30, 5000) returning id into v_customer;
  perform public.set_professional_services(v_ana, array[v_consulta, v_customer]);
  v_r := public.owner_create_appointment(jsonb_build_object(
    'business_id', v_a, 'service_id', v_customer, 'professional_id', v_ana, 'date', v_tue + 1, 'time', '09:00',
    'customer_name', 'Histórico', 'customer_phone', '11999990024'));
  delete from public.services where id = v_customer;
  assert (select service_id is null and service_name = 'Temporário' and price_cents = 5000
          from public.appointments where id = (v_r ->> 'id')::uuid), 'serviço apagado, história mantida';

  -- Clientes: resumo e apagar (LGPD) levando o histórico junto.
  v_r := public.owner_customers(v_a);
  assert (select (c ->> 'no_shows')::integer = 1 and (c ->> 'completed')::integer = 0
          from jsonb_array_elements(v_r) c where c ->> 'phone' = '11999990022'), 'falta contada';
  assert (select (c ->> 'canceled')::integer >= 1 from jsonb_array_elements(v_r) c where c ->> 'phone' = '11999990001'), 'cancelamento contado';
  assert (select (c ->> 'upcoming')::integer = 1 and c ->> 'next_at' is not null
          from jsonb_array_elements(v_r) c where c ->> 'phone' = '11999990020'), 'próximo agendamento';
  select id into v_customer from public.customers where business_id = v_a and phone = '11999990022';
  delete from public.customers where id = v_customer;
  assert not exists (select 1 from public.appointments where customer_id = v_customer), 'apagar o cliente apaga o histórico dele';
end;
$$;

-- ---------------------------------------------------------------------------
-- 8. Enxurrada de agendamentos do mesmo telefone
-- ---------------------------------------------------------------------------
do $$
declare
  v_b uuid := (select id from public.businesses where slug = 'salao-teste');
  v_corte uuid := (select id from public.services where business_id = v_b and name = 'Corte masculino');
  v_today date := public.local_today();
  v_tue date := v_today + 8 + ((2 - extract(dow from v_today + 8)::integer + 7) % 7);
  v_i integer;
begin
  perform set_config('request.jwt.claims', '', true);
  for v_i in 0..4 loop
    perform public.book_appointment(jsonb_build_object(
      'business_id', v_b, 'service_id', v_corte, 'starts_at', public.local_ts(v_tue, ('09:00'::time + make_interval(mins => 30 * v_i))::time),
      'customer_name', 'Repetido', 'customer_phone', '11999990030'));
  end loop;
  assert (select count(*) from public.appointments where business_id = v_b and status = 'confirmed') = 5, 'salão confirma sozinho';
  assert pg_temp.raises(format($q$select public.book_appointment(%L)$q$, jsonb_build_object(
    'business_id', v_b, 'service_id', v_corte, 'starts_at', public.local_ts(v_tue, '14:00'),
    'customer_name', 'Repetido', 'customer_phone', '11999990030')), 'AG429'), 'sexto agendamento em aberto do mesmo telefone';
end;
$$;

-- ---------------------------------------------------------------------------
-- 9. Permissões: anônimo, dono de outro estabelecimento e a lista de funções expostas
-- ---------------------------------------------------------------------------
do $$
declare
  v_a uuid := (select id from public.businesses where slug = 'clinica-teste');
  v_b uuid := (select id from public.businesses where slug = 'salao-teste');
  v_consulta uuid := (select id from public.services where business_id = v_a and name = 'Consulta');
  v_appointment uuid := (select id from public.appointments where business_id = v_a limit 1);
  v_customer uuid := (select id from public.customers where business_id = v_a limit 1);
  v_today date := public.local_today();
  v_count integer;
  v_list text;
begin
  -- Anônimo: vê a vitrine, não vê agenda, cliente, bloqueio nem contador; não grava em nada.
  perform set_config('request.jwt.claims', '{"role": "anon"}', true);
  set local role anon;
  select count(*) into v_count from public.businesses;
  assert v_count >= 2, 'anônimo vê os estabelecimentos';
  select count(*) into v_count from public.services where business_id = v_a;
  assert v_count > 0, 'anônimo vê os serviços';
  assert pg_temp.raises('select count(*) from public.appointments', '42501'), 'anônimo não lê agendamentos';
  assert pg_temp.raises('select count(*) from public.customers', '42501'), 'anônimo não lê clientes';
  assert pg_temp.raises('select count(*) from public.blocks', '42501'), 'anônimo não lê bloqueios';
  assert pg_temp.raises('select count(*) from public.rate_limits', '42501'), 'anônimo não lê contadores';
  assert pg_temp.raises(format('update public.businesses set name = %L where id = %L', 'Invadido', v_a), '42501'), 'anônimo não altera estabelecimento';
  assert pg_temp.raises(format('insert into public.services (business_id, name, duration_minutes) values (%L, %L, 30)', v_a, 'Grátis'), '42501'), 'anônimo não cria serviço';
  assert pg_temp.raises(format('delete from public.professionals where business_id = %L', v_a), '42501'), 'anônimo não apaga profissional';
  assert pg_temp.raises(format('select * from public.slot_candidates(%L, %L, null, %L, %L, null, false)', v_a, v_consulta, v_today, v_today), '42501'),
    'anônimo não chama a função interna de horários';
  assert pg_temp.raises(format('select public.owner_agenda(%L, %L, %L)', v_a, v_today, v_today), '42501'), 'anônimo não chama função do painel';
  assert pg_temp.raises(format('select public.owner_customers(%L)', v_a), '42501'), 'anônimo não lista clientes';
  assert pg_temp.raises(format('select public.owner_set_appointment_status(%L, %L)', v_appointment, 'canceled'), '42501'), 'anônimo não muda situação';
  assert pg_temp.raises($q$select public.rate_touch('x', interval '1 hour')$q$, '42501'), 'anônimo não mexe em contador';
  assert pg_temp.raises($q$select public.create_business('{"name": "Anon", "slug": "anonimo", "segment": "salao"}')$q$, '42501'), 'anônimo não cria estabelecimento';
  -- O que ele pode: horários livres (sem dados de ninguém).
  assert (public.get_availability(v_a, v_consulta) ->> 'accepting')::boolean, 'anônimo consulta horários livres';
  reset role;

  -- Dono do salão tentando mexer na clínica.
  perform pg_temp.login('00000000-0000-0000-0000-0000000000a2');
  set local role authenticated;
  select count(*) into v_count from public.appointments where business_id = v_a;
  assert v_count = 0, 'outro dono não enxerga agendamentos da clínica';
  select count(*) into v_count from public.appointments where business_id = v_b;
  assert v_count = 5, 'mas enxerga os seus';
  select count(*) into v_count from public.customers where business_id = v_a;
  assert v_count = 0, 'outro dono não enxerga clientes da clínica';
  select count(*) into v_count from public.blocks;
  assert v_count = 0, 'nem bloqueios';
  update public.businesses set name = 'Invadido' where id = v_a;
  get diagnostics v_count = row_count;
  assert v_count = 0, 'outro dono não altera a clínica';
  update public.services set price_cents = 1 where business_id = v_a;
  get diagnostics v_count = row_count;
  assert v_count = 0, 'outro dono não altera serviços da clínica';
  update public.customers set name = 'Invadido' where id = v_customer;
  get diagnostics v_count = row_count;
  assert v_count = 0, 'outro dono não altera clientes da clínica';
  delete from public.customers where id = v_customer;
  get diagnostics v_count = row_count;
  assert v_count = 0, 'outro dono não apaga clientes da clínica';
  assert pg_temp.raises(format('insert into public.services (business_id, name, duration_minutes) values (%L, %L, 30)', v_a, 'Intruso'), '42501'),
    'outro dono não cria serviço na clínica';
  assert pg_temp.raises(format('insert into public.professionals (business_id, name) values (%L, %L)', v_a, 'Intruso'), '42501'),
    'outro dono não cria profissional na clínica';
  assert pg_temp.raises(format('update public.appointments set status = %L where id = %L', 'canceled', v_appointment), '42501'),
    'ninguém altera agendamento direto na tabela';
  assert pg_temp.raises(format('insert into public.working_hours (business_id, weekday, start_time, end_time) values (%L, 1, %L, %L)', v_b, '00:00', '23:00'), '42501'),
    'expediente só pela função';
  assert pg_temp.raises(format('update public.businesses set owner_id = %L where id = %L', '00000000-0000-0000-0000-0000000000a3', v_b), '42501'),
    'dono não troca o dono';
  assert pg_temp.raises(format('select public.owner_agenda(%L, %L, %L)', v_a, v_today, v_today), 'AG403'), 'agenda de outro estabelecimento';
  assert pg_temp.raises(format('select public.owner_customers(%L)', v_a), 'AG403'), 'clientes de outro estabelecimento';
  assert pg_temp.raises(format('select public.owner_availability(%L, %L, null, %L)', v_a, v_consulta, v_today), 'AG403'), 'horários de outro estabelecimento';
  assert pg_temp.raises(format('select public.owner_set_appointment_status(%L, %L)', v_appointment, 'canceled'), 'AG403'), 'situação em outro estabelecimento';
  assert pg_temp.raises(format($q$select public.owner_reschedule_appointment(%L)$q$,
    jsonb_build_object('appointment_id', v_appointment, 'date', v_today + 20, 'time', '09:00', 'force', true)), 'AG403'), 'remarcar em outro estabelecimento';
  assert pg_temp.raises(format($q$select public.owner_create_appointment(%L)$q$, jsonb_build_object(
    'business_id', v_a, 'service_id', v_consulta, 'professional_id', (select id from public.professionals where business_id = v_a limit 1),
    'date', v_today + 20, 'time', '09:00', 'force', true, 'customer_name', 'Intruso', 'customer_phone', '11999990040')), 'AG403'),
    'agendar em outro estabelecimento';
  assert pg_temp.raises(format('select public.owner_create_block(%L, null, %L, %L, %L, %L)', v_a, v_today, '00:00', v_today + 1, '00:00'), 'AG403'),
    'bloquear outro estabelecimento';
  assert pg_temp.raises(format($q$select public.set_working_hours(%L, null, '[]')$q$, v_a), 'AG403'), 'expediente de outro estabelecimento';
  assert pg_temp.raises(format('select public.set_professional_services(%L, %L)',
    (select id from public.professionals where business_id = v_a limit 1), '{}'), 'AG403'), 'serviços de profissional alheio';
  -- No próprio estabelecimento ele pode.
  update public.businesses set description = 'Corte e barba' where id = v_b;
  get diagnostics v_count = row_count;
  assert v_count = 1, 'dono altera o próprio estabelecimento';
  assert jsonb_array_length(public.owner_agenda(v_b, v_today, v_today + 30) -> 'appointments') = 5, 'dono vê a própria agenda';
  reset role;
  perform set_config('request.jwt.claims', '', true);

  -- Limite de uso da IA: 25 mensagens por cliente a cada 10 minutos; a 26ª é recusada.
  -- Outro cliente do mesmo estabelecimento continua podendo; estabelecimento inexistente, nunca.
  for v_count in 1..25 loop
    assert public.ai_rate_hit(v_a, 'cliente-insistente'), 'dentro do teto na mensagem ' || v_count;
  end loop;
  assert not public.ai_rate_hit(v_a, 'cliente-insistente'), '26ª mensagem recusada';
  assert public.ai_rate_hit(v_a, 'outro-cliente'), 'outro cliente não é afetado';
  assert not public.ai_rate_hit(gen_random_uuid(), 'x'), 'estabelecimento inexistente';

  -- A lista exata de funções expostas é conferida em pagamentos.sql (a última migração).
  -- Nenhuma função aberta para "todo mundo" (PUBLIC).
  assert not exists (
    select 1 from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) acl
    where p.pronamespace = 'public'::regnamespace and acl.grantee = 0
  ), 'nenhuma função com permissão para PUBLIC';
  -- Tabelas: o anônimo só tem leitura da vitrine; RLS ligado em todas.
  select string_agg(distinct table_name || ':' || privilege_type, ',' order by table_name || ':' || privilege_type) into v_list
  from information_schema.role_table_grants where table_schema = 'public' and grantee = 'anon';
  -- (a leitura de businesses é concedida coluna a coluna, sem a chave Pix e sem o dono; ver pagamentos.sql)
  assert v_list = 'professional_services:SELECT,professionals:SELECT,services:SELECT,working_hours:SELECT',
    'privilégios do anônimo: ' || v_list;
  assert not exists (
    select 1 from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind = 'r' and not c.relrowsecurity
  ), 'RLS ligado em todas as tabelas';
end;
$$;

rollback;
\echo 'agenda.sql: todas as regras passaram'
