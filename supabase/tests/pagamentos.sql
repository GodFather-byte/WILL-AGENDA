-- Teste das regras de pagamento no banco (rode num banco com as migrações aplicadas).
-- psql -v ON_ERROR_STOP=1 -f supabase/tests/pagamentos.sql
-- O provedor não participa: aqui se testa o que o banco garante (interruptor, reserva com prazo,
-- idempotência, conferência de valor, estorno pendente e quem pode o quê).
begin;

create function pg_temp.raises(p_sql text, p_state text)
returns boolean language plpgsql as $$
begin
  execute p_sql;
  raise notice 'esperava erro %, mas o comando passou: %', p_state, p_sql;
  return false;
exception when others then
  if sqlstate = p_state then return true; end if;
  raise notice 'esperava erro %, veio % (%): %', p_state, sqlstate, sqlerrm, p_sql;
  return false;
end;
$$;

create function pg_temp.login(p_user uuid) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
$$;

-- Agenda um corte às p_time do dia de teste e devolve o token.
create function pg_temp.book(p_business uuid, p_time time, p_phone text) returns uuid language sql as $$
  select (public.book_appointment(jsonb_build_object(
    'business_id', p_business,
    'service_id', (select id from public.services where business_id = p_business and name = 'Corte feminino'),
    'starts_at', public.local_ts(public.local_today() + 8 + ((3 - extract(dow from public.local_today() + 8)::integer + 7) % 7), p_time),
    'customer_name', 'Cliente Teste', 'customer_phone', p_phone)) ->> 'token')::uuid;
$$;

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000b1', 'dona-pagamento@teste.local'),
  ('00000000-0000-0000-0000-0000000000b2', 'outro-pagamento@teste.local');
select pg_temp.login('00000000-0000-0000-0000-0000000000b1');
select public.create_business('{"name": "Salão Pagamento", "slug": "salao-pagamento", "segment": "salao"}'::jsonb);
select pg_temp.login('00000000-0000-0000-0000-0000000000b2');
select public.create_business('{"name": "Outro Salão", "slug": "outro-salao-pagamento", "segment": "salao"}'::jsonb);

do $$
declare
  v_b uuid := (select id from public.businesses where slug = 'salao-pagamento');
  v_key text := 'chave-de-acesso-do-servidor';
  v_hash text := encode(sha256(convert_to('chave-de-acesso-do-servidor', 'utf8')), 'hex');
  v_proof text := 'prova-do-servidor-do-app';
  v_token uuid;
  v_other uuid;
  v_row public.appointments%rowtype;
  v_r jsonb;
  v_payment uuid;
  v_count integer;
  v_list text;
begin
  -- 1. Desligado por padrão: nada muda para o cliente e nenhuma cobrança nasce.
  assert (select not charge_on_booking and deposit_type = 'percent' and deposit_value = 30 from public.businesses where id = v_b), 'desligado por padrão';
  perform set_config('request.jwt.claims', '', true);
  v_token := pg_temp.book(v_b, '09:00', '11999990201');
  select * into v_row from public.appointments where public_token = v_token;
  assert v_row.status = 'confirmed' and v_row.payment_status = 'none' and v_row.hold_expires_at is null, 'sem cobrança: confirmado como antes';
  assert v_row.deposit_cents = 2400, 'sinal de 30% de R$ 80,00 fica anotado: ' || v_row.deposit_cents;
  assert (select count(*) from public.payments) = 0, 'nenhuma cobrança criada';
  assert pg_temp.raises(format('select public.payment_begin(%L)', v_token), 'AG409'), 'não há o que pagar com a cobrança desligada';
  assert (public.get_appointment(v_token) ->> 'payment_status') = 'none', 'cliente vê sem cobrança';

  -- Valor do sinal.
  assert public.deposit_for('percent', 30, 8000) = 2400 and public.deposit_for('percent', 33, 1000) = 330, 'percentual';
  assert public.deposit_for('fixed', 5000, 8000) = 5000 and public.deposit_for('fixed', 9000, 8000) = 8000, 'fixo não passa do preço';
  assert public.deposit_for('full', 30, 8000) = 8000, 'valor total';
  assert pg_temp.raises(format('update public.businesses set deposit_type = %L, deposit_value = 150 where id = %L', 'percent', v_b), '23514'), 'percentual acima de 100';

  -- Confirmação manual do Pix copia e cola: o dono marca e desmarca.
  perform pg_temp.login('00000000-0000-0000-0000-0000000000b1');
  assert (public.owner_mark_paid(v_row.id, true) ->> 'payment_status') = 'manual_paid', 'dono marca recebido';
  assert (public.get_appointment(v_token) ->> 'payment_status') = 'manual_paid', 'cliente vê confirmado pelo estabelecimento';
  assert (public.owner_mark_paid(v_row.id, false) ->> 'payment_status') = 'none', 'dono desfaz';

  -- 2. O interruptor só liga com credencial; a credencial só entra pelo dono e nunca volta em texto.
  assert pg_temp.raises(format('select public.set_charge_on_booking(%L, true)', v_b), 'AG409'), 'sem credencial não liga';
  -- Sem a prova do servidor (instalação não habilitada, ou dono chamando o banco direto) a credencial não entra.
  assert pg_temp.raises(format('select public.set_payment_credentials(%L, %L, %L, %L, %L, %L)', v_b, 'mercadopago', 'v1.texto-cifrado-pelo-servidor.abcdef', '9f3a', v_hash, v_proof), 'AG403'),
    'instalação sem a prova semeada';
  insert into public.server_keys (purpose, key_hash) values ('payments', encode(sha256(convert_to(v_proof, 'utf8')), 'hex'))
  on conflict (purpose) do update set key_hash = excluded.key_hash;
  assert pg_temp.raises(format('select public.set_payment_credentials(%L, %L, %L, %L, %L, %L)', v_b, 'mercadopago', 'v1.texto-cifrado-pelo-servidor.abcdef', '9f3a', v_hash, 'chute-do-dono'), 'AG403'),
    'dono não cadastra credencial sem passar pelo servidor';
  assert pg_temp.raises(format('select public.set_payment_credentials(%L, %L, %L, %L, %L, null)', v_b, 'mercadopago', 'v1.texto-cifrado-pelo-servidor.abcdef', '9f3a', v_hash), 'AG403'),
    'nem sem prova nenhuma';
  perform public.set_payment_credentials(v_b, 'mercadopago', 'v1.texto-cifrado-pelo-servidor.abcdef', '9f3a', v_hash, v_proof);
  v_r := public.payment_credentials_status(v_b);
  assert (v_r ->> 'connected')::boolean and v_r ->> 'key_hint' = '9f3a' and not (v_r ? 'ciphertext'), 'dono vê só a dica';
  assert pg_temp.raises(format('select public.server_payment_credentials(%L, %L)', v_b, 'chave-errada'), 'AG403'), 'servidor com chave errada';
  assert pg_temp.raises(format('select public.server_payment_credentials(%L, null)', v_b), 'AG403'), 'servidor sem chave';
  assert (public.server_payment_credentials(v_b, v_key) ->> 'ciphertext') = 'v1.texto-cifrado-pelo-servidor.abcdef', 'servidor com a chave certa recebe o texto cifrado';
  assert public.set_charge_on_booking(v_b, true), 'com credencial, liga';

  -- Outro dono não mexe nisso.
  perform pg_temp.login('00000000-0000-0000-0000-0000000000b2');
  assert pg_temp.raises(format('select public.set_payment_credentials(%L, %L, %L, %L, %L, %L)', v_b, 'mercadopago', 'x'||repeat('y', 30), 'aaaa', v_hash, v_proof), 'AG403'), 'outro dono não troca credencial';
  assert pg_temp.raises(format('select public.set_charge_on_booking(%L, false)', v_b), 'AG403'), 'outro dono não desliga';
  assert pg_temp.raises(format('select public.payment_credentials_status(%L)', v_b), 'AG403'), 'outro dono não vê a credencial';
  assert pg_temp.raises(format('select public.owner_mark_paid(%L, true)', v_row.id), 'AG403'), 'outro dono não marca pagamento';
  assert pg_temp.raises(format('select public.delete_payment_credentials(%L)', v_b), 'AG403'), 'outro dono não apaga credencial';

  -- 3. Ligado: o agendamento do cliente nasce aguardando pagamento, com o horário reservado.
  perform set_config('request.jwt.claims', '', true);
  v_token := pg_temp.book(v_b, '10:00', '11999990202');
  select * into v_row from public.appointments where public_token = v_token;
  assert v_row.status = 'pending' and v_row.payment_status = 'awaiting' and v_row.deposit_cents = 2400, 'aguardando pagamento';
  assert v_row.hold_expires_at between now() + interval '14 minutes' and now() + interval '16 minutes', 'reserva de 15 minutos';
  assert pg_temp.raises(format('select pg_temp.book(%L, %L, %L)', v_b, '10:00', '11999990203'), 'AG409'), 'horário reservado não é oferecido a outro';

  -- Remarcar sem ter pago não confirma o horário (o salão confirma sozinho, mas só depois do sinal).
  v_r := public.reschedule_appointment(v_token, public.local_ts((v_row.starts_at at time zone public.tz())::date, '10:30'));
  assert v_r ->> 'status' = 'pending' and v_r ->> 'payment_status' = 'awaiting' and v_r ->> 'time' = '10:30', 'remarcar não dribla o pagamento: ' || (v_r ->> 'status');
  perform pg_temp.login('00000000-0000-0000-0000-0000000000b1');
  assert (public.owner_set_appointment_status(v_row.id, 'confirmed') ->> 'status') = 'pending', 'nem o botão de confirmar pula o sinal';
  perform set_config('request.jwt.claims', '', true);
  v_r := public.reschedule_appointment(v_token, public.local_ts((v_row.starts_at at time zone public.tz())::date, '10:00'));
  assert v_r ->> 'status' = 'pending', 'de volta às 10:00, ainda aguardando';

  -- Começar o pagamento é idempotente: duas chamadas, uma cobrança.
  v_r := public.payment_begin(v_token);
  v_payment := (v_r ->> 'payment_id')::uuid;
  assert (v_r ->> 'amount_cents')::integer = 2400 and v_r ->> 'provider' = 'mercadopago' and v_r ->> 'pix_code' is null, 'cobrança criada';
  assert (public.payment_begin(v_token) ->> 'payment_id')::uuid = v_payment, 'segunda chamada devolve a mesma cobrança';
  assert (select count(*) from public.payments where appointment_id = v_row.id) = 1, 'uma cobrança só';
  assert pg_temp.raises(format('insert into public.payments (business_id, appointment_id, provider, amount_cents, expires_at) values (%L, %L, %L, 2400, now())', v_b, v_row.id, 'mercadopago'), '23505'),
    'o banco não deixa nascer segunda cobrança viva';

  -- Só o servidor (com a chave) grava o que o provedor devolveu.
  assert pg_temp.raises(format('select public.server_payment_attach(%L, %L, %L, %L, %L, null)', v_b, 'errada', v_payment, 'mp-1', 'pix'), 'AG403'), 'anexar sem chave';
  perform public.server_payment_attach(v_b, v_key, v_payment, 'mp-1001', '00020126...PIX', 'https://provedor.exemplo/ticket');
  assert (public.payment_begin(v_token) ->> 'pix_code') = '00020126...PIX', 'cliente recebe o código Pix da cobrança';
  assert (public.get_appointment(v_token) -> 'payment' ->> 'pix_code') = '00020126...PIX', 'e vê na página dele';

  -- Resultado conferido no provedor: pendente não muda nada; valor diferente não confirma; chave errada não entra.
  assert pg_temp.raises(format('select public.server_payment_result(%L, %L, %L, %L, %L, 2400)', v_b, 'errada', 'mercadopago', 'mp-1001', 'approved'), 'AG403'), 'resultado sem chave';
  assert (public.server_payment_result(v_b, v_key, 'mercadopago', 'mp-1001', 'pending', null) ->> 'state') = 'pending', 'pendente';
  assert (public.server_payment_result(v_b, v_key, 'mercadopago', 'mp-1001', 'approved', 100) ->> 'state') = 'amount_mismatch', 'valor diferente';
  assert (public.server_payment_result(v_b, v_key, 'mercadopago', 'mp-9999', 'approved', 2400) ->> 'state') = 'unknown', 'cobrança desconhecida';
  assert (select payment_status = 'awaiting' and status = 'pending' from public.appointments where id = v_row.id), 'nada confirmado até aqui';

  -- Aprovado com o valor certo: pago e confirmado. Repetir (webhook duplicado) não muda nada.
  assert (public.server_payment_result(v_b, v_key, 'mercadopago', 'mp-1001', 'approved', 2400) ->> 'state') = 'paid', 'pago';
  assert (select status = 'confirmed' and payment_status = 'paid' and hold_expires_at is null from public.appointments where id = v_row.id), 'agendamento confirmado';
  assert (public.server_payment_result(v_b, v_key, 'mercadopago', 'mp-1001', 'approved', 2400) ->> 'state') = 'paid', 'repetição inofensiva';
  assert (select count(*) from public.payments where appointment_id = v_row.id and status = 'paid' and paid_at is not null) = 1, 'um pagamento só';
  assert pg_temp.raises(format('select public.payment_begin(%L)', v_token), 'AG409'), 'já pago não paga de novo';
  perform pg_temp.login('00000000-0000-0000-0000-0000000000b1');
  assert pg_temp.raises(format('select public.owner_mark_paid(%L, false)', v_row.id), 'AG409'), 'pagamento do provedor não é marcado à mão';

  -- 4. Cliente cancela dentro da regra: estorno pendente, feito pelo servidor, registrado uma vez.
  perform set_config('request.jwt.claims', '', true);
  perform public.cancel_appointment(v_token, 'imprevisto');
  assert (select payment_status = 'refund_pending' and status = 'canceled' from public.appointments where id = v_row.id), 'estorno pendente no agendamento';
  v_r := public.server_pending_refunds(v_b, v_key);
  assert jsonb_array_length(v_r) = 1 and v_r -> 0 ->> 'provider_payment_id' = 'mp-1001' and (v_r -> 0 ->> 'amount_cents')::integer = 2400, 'estorno na fila do servidor';
  perform public.server_refund_result(v_b, v_key, v_payment, false, null);
  assert (select status = 'refund_pending' and refund_attempts = 1 from public.payments where id = v_payment), 'falha no estorno fica pendente para nova tentativa';
  perform public.server_refund_result(v_b, v_key, v_payment, true, 'refund-77');
  assert (select status = 'refunded' and refund_id = 'refund-77' and refunded_at is not null from public.payments where id = v_payment), 'estornado';
  assert (public.get_appointment(v_token) ->> 'payment_status') = 'refunded', 'cliente vê o estorno';
  assert jsonb_array_length(public.server_pending_refunds(v_b, v_key)) = 0, 'fila vazia';
  perform public.server_refund_result(v_b, v_key, v_payment, true, 'refund-outro');
  assert (select refund_id from public.payments where id = v_payment) = 'refund-77', 'registrar o estorno de novo não muda nada';

  -- 5. Reserva vencida: o horário volta a ser oferecido e quem chegar leva.
  v_token := pg_temp.book(v_b, '11:00', '11999990204');
  v_payment := (public.payment_begin(v_token) ->> 'payment_id')::uuid;
  perform public.server_payment_attach(v_b, v_key, v_payment, 'mp-2002', 'PIX2', null);
  assert not public.release_hold(v_token), 'reserva em dia não é liberada';
  update public.appointments set hold_expires_at = now() - interval '1 minute' where public_token = v_token;
  assert (public.get_appointment(v_token) ->> 'hold_expired')::boolean, 'cliente vê que venceu';
  assert pg_temp.raises(format('select public.payment_begin(%L)', v_token), 'AG409'), 'vencida não paga';
  -- Vencida, não remarca mais (senão seguraria outro horário sem pagar).
  assert pg_temp.raises(format('select public.reschedule_appointment(%L, %L)', v_token,
    public.local_ts(public.local_today() + 8 + ((3 - extract(dow from public.local_today() + 8)::integer + 7) % 7), '15:00')), 'AG409'), 'reserva vencida não remarca';
  v_other := pg_temp.book(v_b, '11:00', '11999990205');
  assert (select status = 'pending' and payment_status = 'awaiting' from public.appointments where public_token = v_other), 'outro cliente ficou com o horário';
  assert (select status = 'canceled' and payment_status = 'none' and cancel_reason = 'Pagamento não realizado no prazo'
          from public.appointments where public_token = v_token), 'a reserva vencida caiu';
  assert (select status from public.payments where id = v_payment) = 'expired', 'a cobrança dela venceu';
  -- Pagamento que chega depois de a reserva cair: o dinheiro volta.
  assert (public.server_payment_result(v_b, v_key, 'mercadopago', 'mp-2002', 'approved', 2400) ->> 'state') = 'refund_pending', 'pago tarde: estorno pendente';
  assert jsonb_array_length(public.server_pending_refunds(v_b, v_key)) = 1, 'entra na fila de estorno';
  assert (select status from public.appointments where public_token = v_token) = 'canceled', 'e o agendamento continua cancelado';

  -- Liberar pela página do cliente: só o que venceu.
  update public.appointments set hold_expires_at = now() - interval '1 minute' where public_token = v_other;
  assert public.release_hold(v_other), 'vencida é liberada ao abrir a página';
  assert (select status from public.appointments where public_token = v_other) = 'canceled', 'liberada';

  -- Provedor recusou ou a cobrança venceu lá: a cobrança é encerrada e outra pode nascer.
  v_token := pg_temp.book(v_b, '13:00', '11999990206');
  v_payment := (public.payment_begin(v_token) ->> 'payment_id')::uuid;
  perform public.server_payment_attach(v_b, v_key, v_payment, 'mp-3003', 'PIX3', null);
  assert (public.server_payment_result(v_b, v_key, 'mercadopago', 'mp-3003', 'failed', null) ->> 'state') = 'canceled', 'recusado no provedor';
  assert (public.payment_begin(v_token) ->> 'payment_id')::uuid <> v_payment, 'nova cobrança para o mesmo agendamento';

  -- O dono recebeu por fora: libera do sinal, confirma e encerra a cobrança em aberto.
  perform pg_temp.login('00000000-0000-0000-0000-0000000000b1');
  v_r := public.owner_mark_paid((select id from public.appointments where public_token = v_token), true);
  assert v_r ->> 'status' = 'confirmed' and v_r ->> 'payment_status' = 'manual_paid' and v_r ->> 'hold_expires_at' is null, 'liberado pelo dono';
  assert not exists (select 1 from public.payments p join public.appointments a on a.id = p.appointment_id
                     where a.public_token = v_token and p.status = 'pending'), 'cobrança em aberto encerrada';

  -- 6. Agendamento feito pelo dono no painel não exige pagamento.
  perform pg_temp.login('00000000-0000-0000-0000-0000000000b1');
  v_r := public.owner_create_appointment(jsonb_build_object(
    'business_id', v_b, 'service_id', (select id from public.services where business_id = v_b and name = 'Corte feminino'),
    'professional_id', (select id from public.professionals where business_id = v_b),
    'date', public.local_today() + 8 + ((3 - extract(dow from public.local_today() + 8)::integer + 7) % 7), 'time', '16:00',
    'customer_name', 'Balcão', 'customer_phone', '11999990207'));
  assert v_r ->> 'status' = 'confirmed' and v_r ->> 'payment_status' = 'none', 'painel não cobra';

  -- Remover a credencial desliga a cobrança.
  perform public.delete_payment_credentials(v_b);
  assert (select not charge_on_booking from public.businesses where id = v_b), 'sem credencial, cobrança desligada';
  assert pg_temp.raises(format('select public.server_payment_credentials(%L, %L)', v_b, v_key), 'AG403'), 'sem credencial, servidor não entra';

  -- 7. Quem pode o quê.
  perform set_config('request.jwt.claims', '{"role": "anon"}', true);
  set local role anon;
  assert pg_temp.raises('select count(*) from public.payment_credentials', '42501'), 'anônimo não lê credenciais';
  assert pg_temp.raises('select count(*) from public.server_keys', '42501'), 'anônimo não lê a prova do servidor';
  assert pg_temp.raises('select pix_key from public.businesses', '42501'), 'anônimo não lista chaves Pix';
  assert pg_temp.raises('select owner_id from public.businesses', '42501'), 'anônimo não lista donos';
  assert pg_temp.raises('select * from public.businesses', '42501'), 'nem com asterisco';
  select count(*) into v_count from public.businesses where has_pix;
  assert v_count >= 0, 'anônimo sabe só se há chave Pix';
  assert pg_temp.raises('select count(*) from public.payments', '42501'), 'anônimo não lê pagamentos';
  assert pg_temp.raises(format('update public.businesses set charge_on_booking = true where id = %L', v_b), '42501'), 'anônimo não liga cobrança';
  assert pg_temp.raises(format('select public.set_payment_credentials(%L, %L, %L, %L, %L, %L)', v_b, 'mercadopago', repeat('z', 40), 'aaaa', v_hash, v_proof), '42501'), 'anônimo não cadastra credencial';
  assert pg_temp.raises(format('select public.owner_mark_paid(%L, true)', v_row.id), '42501'), 'anônimo não marca pagamento';
  assert pg_temp.raises(format('select public.require_server_key(%L, %L)', v_b, v_key), '42501'), 'função interna fechada';
  reset role;
  perform pg_temp.login('00000000-0000-0000-0000-0000000000b1');
  set local role authenticated;
  assert pg_temp.raises('select count(*) from public.payment_credentials', '42501'), 'nem o dono lê a tabela de credenciais';
  assert pg_temp.raises('select pix_key from public.businesses', '42501'), 'conta logada não lista chaves Pix de todos';
  assert pg_temp.raises(format('update public.businesses set charge_on_booking = true where id = %L', v_b), '42501'), 'o interruptor só liga pela função';
  assert pg_temp.raises(format('update public.payments set status = %L where business_id = %L', 'paid', v_b), '42501'), 'dono não altera pagamento';
  select count(*) into v_count from public.payments where business_id = v_b;
  assert v_count >= 4, 'dono vê os pagamentos do próprio estabelecimento';
  update public.businesses set pix_key = 'pix@salao.exemplo', deposit_type = 'full' where id = v_b;
  get diagnostics v_count = row_count;
  assert v_count = 1, 'dono cadastra chave Pix e regra do sinal';
  assert (public.payment_credentials_status(v_b) ->> 'pix_key') = 'pix@salao.exemplo', 'o dono lê a própria chave pela função';
  reset role;
  perform pg_temp.login('00000000-0000-0000-0000-0000000000b2');
  set local role authenticated;
  select count(*) into v_count from public.payments;
  assert v_count = 0, 'outro dono não vê pagamentos alheios';
  reset role;
  perform set_config('request.jwt.claims', '', true);

  -- Lista exata do que o anônimo consegue executar.
  select string_agg(p.proname, ',' order by p.proname) into v_list
  from pg_proc p where p.pronamespace = 'public'::regnamespace and has_function_privilege('anon', p.oid, 'execute');
  assert v_list = 'ai_rate_hit,book_appointment,cancel_appointment,get_appointment,get_availability,is_business_owner,payment_begin,payment_lookup,release_hold,reschedule_appointment,server_payment_attach,server_payment_credentials,server_payment_result,server_pending_refunds,server_refund_result',
    'funções expostas ao anônimo: ' || v_list;
  -- E as que só o dono logado consegue, além das públicas.
  select string_agg(p.proname, ',' order by p.proname) into v_list
  from pg_proc p where p.pronamespace = 'public'::regnamespace
    and has_function_privilege('authenticated', p.oid, 'execute') and not has_function_privilege('anon', p.oid, 'execute');
  assert v_list = 'create_business,delete_payment_credentials,owner_agenda,owner_availability,owner_create_appointment,owner_create_block,owner_customers,owner_mark_paid,owner_reschedule_appointment,owner_set_appointment_status,payment_credentials_status,set_charge_on_booking,set_payment_credentials,set_professional_services,set_working_hours',
    'funções do painel: ' || v_list;
  assert not exists (
    select 1 from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) acl
    where p.pronamespace = 'public'::regnamespace and acl.grantee = 0
  ), 'nenhuma função com permissão para PUBLIC';
  assert not exists (
    select 1 from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind = 'r' and not c.relrowsecurity
  ), 'RLS ligado em todas as tabelas';
end;
$$;

rollback;
\echo 'pagamentos.sql: todas as regras passaram'
