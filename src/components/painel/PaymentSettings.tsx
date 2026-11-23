"use client";

import { useCallback, useEffect, useState } from "react";
import { brl, centsToInput, depositFor, errorMessage, parseBRL } from "@/lib/format";
import { createClient } from "@/lib/supabase/client";
import { useBusiness } from "./BusinessContext";

type Status = { available: boolean; connected: boolean; provider?: string; key_hint?: string };

/**
 * Pagamentos. Duas coisas independentes:
 *  - chave Pix: mostra ao cliente um QR "copia e cola" com o valor; quem confirma é o dono, à mão;
 *  - cobrança no agendamento (desligada por padrão): exige as credenciais do provedor do
 *    estabelecimento; o cliente paga o sinal para confirmar e a confirmação é automática.
 */
export function PaymentSettings() {
  const { business, setBusiness } = useBusiness();
  const [pixKey, setPixKey] = useState(business.pix_key ?? "");
  const [type, setType] = useState(business.deposit_type);
  const [value, setValue] = useState(
    business.deposit_type === "fixed" ? centsToInput(business.deposit_value) : String(business.deposit_value),
  );
  const [hold, setHold] = useState(business.hold_minutes);
  const [status, setStatus] = useState<Status | null>(null);
  const [credential, setCredential] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const loadStatus = useCallback(async () => {
    const response = await fetch("/api/painel/pagamentos/credenciais").catch(() => null);
    setStatus(response?.ok ? ((await response.json()) as Status) : { available: false, connected: false });
  }, []);

  useEffect(() => {
    const first = setTimeout(loadStatus, 0);
    return () => clearTimeout(first);
  }, [loadStatus]);

  async function saveRules(event: React.FormEvent) {
    event.preventDefault();
    setMessage(null);
    const amount = type === "fixed" ? parseBRL(value) : type === "percent" ? parseInt(value) : business.deposit_value;
    if (type === "percent" && !(amount! >= 1 && amount! <= 100)) return setMessage({ ok: false, text: "O percentual do sinal deve ficar entre 1 e 100." });
    if (type === "fixed" && (amount === null || amount < 1)) return setMessage({ ok: false, text: "Valor do sinal inválido. Use o formato 30,00." });
    setBusy(true);
    const patch = { pix_key: pixKey.trim() || null, deposit_type: type, deposit_value: amount as number, hold_minutes: hold };
    const { error } = await createClient().from("businesses").update(patch).eq("id", business.id);
    setBusy(false);
    if (error) return setMessage({ ok: false, text: "Não foi possível salvar." });
    setBusiness({ ...business, ...patch });
    setMessage({ ok: true, text: "Pagamentos salvos." });
  }

  async function saveCredential() {
    setBusy(true);
    setMessage(null);
    const response = await fetch("/api/painel/pagamentos/credenciais", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "mercadopago", credential }),
    }).catch(() => null);
    const body = response ? await response.json().catch(() => ({})) : {};
    setBusy(false);
    // A credencial sai da tela assim que é enviada; daqui em diante só aparecem os 4 últimos caracteres.
    setCredential("");
    if (!response?.ok) return setMessage({ ok: false, text: body.error ?? "Não foi possível guardar a credencial." });
    setMessage({ ok: true, text: "Credencial guardada." });
    await loadStatus();
  }

  async function removeCredential() {
    if (!window.confirm("Remover a credencial? A cobrança no agendamento será desligada.")) return;
    setBusy(true);
    await fetch("/api/painel/pagamentos/credenciais", { method: "DELETE" }).catch(() => null);
    setBusy(false);
    setBusiness({ ...business, charge_on_booking: false });
    await loadStatus();
  }

  async function toggleCharge(on: boolean) {
    setBusy(true);
    setMessage(null);
    const { error } = await createClient().rpc("set_charge_on_booking", { p_business_id: business.id, p_on: on });
    setBusy(false);
    if (error) return setMessage({ ok: false, text: errorMessage(error, "Não foi possível alterar a cobrança.") });
    setBusiness({ ...business, charge_on_booking: on });
  }

  const example = depositFor(
    { deposit_type: type, deposit_value: type === "fixed" ? (parseBRL(value) ?? 0) : parseInt(value) || 0 },
    10000,
  );

  return (
    <section className="card max-w-2xl space-y-5 p-5" aria-labelledby="payments-title">
      <h2 id="payments-title" className="font-semibold">Pagamentos</h2>

      <form onSubmit={saveRules} className="space-y-4">
        <div>
          <label className="label" htmlFor="p-pix">Chave Pix</label>
          <input id="p-pix" maxLength={140} className="input" placeholder="CNPJ, e-mail, telefone ou chave aleatória"
            value={pixKey} onChange={(e) => setPixKey(e.target.value)} />
          <p className="mt-1 text-xs text-stone-500">
            Com a chave, o cliente vê no link do agendamento um QR code Pix com o valor do sinal já preenchido. Esse Pix
            cai direto na sua conta e não é conferido pelo sistema: você marca “pagamento recebido” na agenda. Digite a
            chave exatamente como está no banco; telefone no formato +5511999999999.
          </p>
        </div>
        <div className="grid gap-4 sm:grid-cols-3">
          <div>
            <label className="label" htmlFor="p-type">Sinal</label>
            <select id="p-type" className="input" value={type}
              onChange={(e) => {
                const next = e.target.value as typeof type;
                setType(next);
                setValue(next === "fixed" ? "30,00" : "30");
              }}>
              <option value="percent">Percentual do preço</option>
              <option value="fixed">Valor fixo</option>
              <option value="full">Valor total</option>
            </select>
          </div>
          {type !== "full" && (
            <div>
              <label className="label" htmlFor="p-value">{type === "percent" ? "Percentual (%)" : "Valor (R$)"}</label>
              <input id="p-value" inputMode="decimal" className="input" value={value} onChange={(e) => setValue(e.target.value)} />
            </div>
          )}
          <div>
            <label className="label" htmlFor="p-hold">Prazo para pagar</label>
            <select id="p-hold" className="input" value={hold} onChange={(e) => setHold(Number(e.target.value))}>
              {[10, 15, 20, 30, 60].map((m) => <option key={m} value={m}>{m} minutos</option>)}
            </select>
          </div>
        </div>
        <p className="text-xs text-stone-500">Exemplo: em um serviço de R$ 100,00 o sinal fica em {brl(example)}.</p>
        <button className="btn-outline" disabled={busy}>Salvar pagamentos</button>
      </form>

      <div className="space-y-3 border-t border-stone-200 pt-4">
        <h3 className="text-sm font-semibold">Cobrar no agendamento (sinal pago na hora)</h3>
        <p className="text-xs text-stone-500">
          Desligado, nada muda para o cliente. Ligado, o agendamento feito pelo cliente só confirma depois do Pix do
          sinal, com confirmação automática e devolução do sinal quando o cancelamento acontece dentro do seu prazo.
          Usa a conta do Mercado Pago do seu estabelecimento.
        </p>
        {status === null ? (
          <p className="text-sm text-stone-500">Carregando...</p>
        ) : !status.available ? (
          <p className="rounded-lg bg-stone-100 px-3 py-2 text-sm text-stone-700">
            A cobrança online ainda não foi habilitada nesta instalação.
          </p>
        ) : (
          <>
            {status.connected ? (
              <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-stone-50 px-3 py-2.5 text-sm">
                <span>
                  Mercado Pago conectado <span className="text-stone-500">(credencial terminada em {status.key_hint})</span>
                </span>
                <button type="button" className="font-semibold text-red-700" disabled={busy} onClick={removeCredential}>Remover</button>
              </div>
            ) : (
              <div>
                <label className="label" htmlFor="p-credential">Access token de produção do Mercado Pago</label>
                <div className="flex gap-2">
                  <input id="p-credential" type="password" autoComplete="off" className="input" value={credential}
                    onChange={(e) => setCredential(e.target.value)} />
                  <button type="button" className="btn-outline shrink-0" disabled={busy || credential.trim().length < 20} onClick={saveCredential}>
                    Guardar
                  </button>
                </div>
                <p className="mt-1 text-xs text-stone-500">
                  Fica guardado cifrado e não aparece de novo em nenhuma tela. Você encontra em Mercado Pago → Seu
                  negócio → Configurações → Credenciais.
                </p>
              </div>
            )}
            <label className="flex items-start gap-2 text-sm">
              <input type="checkbox" className="mt-0.5" checked={business.charge_on_booking} disabled={busy || !status.connected}
                onChange={(e) => toggleCharge(e.target.checked)} />
              <span>
                Cobrar o sinal no agendamento
                {!status.connected && <span className="block text-xs text-stone-500">Guarde a credencial para poder ligar.</span>}
              </span>
            </label>
          </>
        )}
      </div>

      {message && (
        <p role={message.ok ? "status" : "alert"} className={`text-sm ${message.ok ? "text-green-700" : "text-red-700"}`}>{message.text}</p>
      )}
    </section>
  );
}
