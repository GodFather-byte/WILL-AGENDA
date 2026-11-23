-- Limite de uso da IA: cada mensagem custa, então o chat público tem teto por cliente (IP só
-- como hash, calculado no servidor do app) e por estabelecimento. O copiloto do dono usa o mesmo teto.

-- Registra uma mensagem e devolve false quando algum teto foi atingido.
-- Os tetos ficam aqui, e não em parâmetros, para não poderem ser alterados por quem chama.
create function public.ai_rate_hit(p_business_id uuid, p_client text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_client_hits integer;
  v_business_hits integer;
begin
  if not exists (select 1 from public.businesses where id = p_business_id) then
    return false;
  end if;
  v_client_hits := public.rate_touch('ai:c:' || p_business_id || ':' || left(coalesce(p_client, ''), 64), interval '10 minutes');
  v_business_hits := public.rate_touch('ai:b:' || p_business_id, interval '1 hour');
  -- 25 mensagens por cliente a cada 10 minutos; 600 por estabelecimento a cada hora.
  return v_client_hits <= 25 and v_business_hits <= 600;
end;
$$;

revoke execute on function public.ai_rate_hit(uuid, text) from public, anon, authenticated;
grant execute on function public.ai_rate_hit(uuid, text) to anon, authenticated;
