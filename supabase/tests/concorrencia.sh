#!/usr/bin/env bash
# Duas (ou dez) pessoas clicando no mesmo horário ao mesmo tempo: só cabe quem couber.
# Usa conexões de verdade em paralelo, então grava dados de teste e apaga no final.
#   bash supabase/tests/concorrencia.sh
set -euo pipefail

DB="${DATABASE_URL:-postgresql://postgres:postgres@127.0.0.1:54322/postgres}"
OWNER="00000000-0000-0000-0000-0000000000c1"
TMP="$(mktemp -d)"

q() { psql "$DB" -v ON_ERROR_STOP=1 -qAt -c "$1"; }
cleanup() {
  q "delete from auth.users where id = '$OWNER'" >/dev/null 2>&1 || true
  rm -rf "$TMP"
}
trap cleanup EXIT
fail() { echo "FALHOU: $1" >&2; exit 1; }

cleanup_previous() { q "delete from auth.users where id = '$OWNER'" >/dev/null; }
cleanup_previous

q "insert into auth.users (id, email) values ('$OWNER', 'concorrencia@teste.local')" >/dev/null
BUSINESS="$(psql "$DB" -v ON_ERROR_STOP=1 -qAt <<SQL | tail -1
select set_config('request.jwt.claims', '{"sub": "$OWNER", "role": "authenticated"}', false) \gset ignorar_
select public.create_business('{"name": "Concorrência", "slug": "teste-concorrencia", "segment": "salao", "professional_name": "Ana"}') ->> 'id';
SQL
)"
SERVICE="$(q "select id from public.services where business_id = '$BUSINESS' and name = 'Corte masculino'")"
# Uma terça-feira com folga de mais de uma semana (o salão do modelo abre de terça a sábado).
DAY="$(q "select public.local_today() + 8 + ((2 - extract(dow from public.local_today() + 8)::integer + 7) % 7)")"

book_sql() { # $1 = hora local, $2 = telefone
  echo "select public.book_appointment(jsonb_build_object('business_id', '$BUSINESS', 'service_id', '$SERVICE', 'starts_at', public.local_ts('$DAY', '$1'), 'customer_name', 'Cliente $2', 'customer_phone', '$2')) ->> 'professional_name'"
}
active_at() { q "select count(*) from public.appointments where business_id = '$BUSINESS' and status = 'confirmed' and starts_at = public.local_ts('$DAY', '$1')"; }

echo "1) Quem chega enquanto o outro ainda está gravando espera e depois é recusado"
psql "$DB" -v ON_ERROR_STOP=1 -qAt -c "begin; $(book_sql 09:00 11900000001); select pg_sleep(2); commit;" >"$TMP/a.out" 2>&1 &
sleep 0.7
START=$(date +%s%N)
psql "$DB" -qAt -c "$(book_sql 09:00 11900000002)" >"$TMP/b.out" 2>&1 || true
WAITED_MS=$(( ($(date +%s%N) - START) / 1000000 ))
wait
grep -q "Ana" "$TMP/a.out" || fail "o primeiro deveria ter agendado: $(cat "$TMP/a.out")"
grep -q "não está mais disponível" "$TMP/b.out" || fail "o segundo deveria ter sido recusado: $(cat "$TMP/b.out")"
[ "$WAITED_MS" -ge 800 ] || fail "o segundo não esperou o primeiro terminar (${WAITED_MS} ms)"
[ "$(active_at 09:00)" = "1" ] || fail "deveria haver exatamente 1 agendamento às 09:00"
echo "   ok: o segundo esperou ${WAITED_MS} ms e foi recusado"

echo "2) Dez pessoas no mesmo horário, um profissional: entra uma só (10 rodadas)"
for round in $(seq 0 9); do
  TIME="$(printf '%02d:%02d' $((10 + round / 2)) $((round % 2 * 30)))"
  for i in $(seq 0 9); do
    psql "$DB" -qAt -c "$(book_sql "$TIME" "119$(printf '%02d' "$round")0000$(printf '%02d' "$i")")" >"$TMP/r$round-$i.out" 2>&1 &
  done
  wait
  OK=$(grep -l "Ana" "$TMP"/r"$round"-*.out | wc -l)
  REFUSED=$(grep -l "não está mais disponível" "$TMP"/r"$round"-*.out | wc -l)
  [ "$OK" = "1" ] && [ "$REFUSED" = "9" ] || fail "rodada $round ($TIME): $OK entraram e $REFUSED foram recusados"
  [ "$(active_at "$TIME")" = "1" ] || fail "rodada $round: mais de um agendamento às $TIME"
done
echo "   ok: 1 agendado e 9 recusados em cada rodada"

echo "3) Dez pessoas no mesmo horário, dois profissionais, 'qualquer um': entram duas, uma com cada"
q "with p as (insert into public.professionals (business_id, name, position) values ('$BUSINESS', 'Bia', 2) returning id)
   insert into public.professional_services (professional_id, service_id, business_id) select p.id, '$SERVICE', '$BUSINESS' from p" >/dev/null
for round in $(seq 0 5); do
  TIME="$(printf '%02d:%02d' $((15 + round / 2)) $((round % 2 * 30)))"
  for i in $(seq 0 9); do
    psql "$DB" -qAt -c "$(book_sql "$TIME" "118$(printf '%02d' "$round")0000$(printf '%02d' "$i")")" >"$TMP/s$round-$i.out" 2>&1 &
  done
  wait
  ANA=$(grep -lx "Ana" "$TMP"/s"$round"-*.out | wc -l)
  BIA=$(grep -lx "Bia" "$TMP"/s"$round"-*.out | wc -l)
  [ "$ANA" = "1" ] && [ "$BIA" = "1" ] || fail "rodada $round ($TIME): Ana $ANA, Bia $BIA (esperado 1 e 1)"
  [ "$(active_at "$TIME")" = "2" ] || fail "rodada $round: deveria haver 2 agendamentos às $TIME"
done
echo "   ok: 1 com cada profissional e 8 recusados em cada rodada"

echo "4) Conferência final: nenhum profissional com dois agendamentos ativos sobrepostos"
OVERLAPS="$(q "select count(*) from public.appointments a join public.appointments b
  on a.professional_id = b.professional_id and a.id < b.id
 and a.status in ('pending', 'confirmed', 'completed') and b.status in ('pending', 'confirmed', 'completed')
 and a.starts_at < b.ends_at and b.starts_at < a.ends_at where a.business_id = '$BUSINESS'")"
[ "$OVERLAPS" = "0" ] || fail "$OVERLAPS sobreposições encontradas"
echo "   ok: 0 sobreposições em $(q "select count(*) from public.appointments where business_id = '$BUSINESS'") agendamentos"

echo "concorrencia.sh: passou"
