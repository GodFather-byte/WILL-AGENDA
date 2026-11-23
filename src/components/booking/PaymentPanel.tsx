"use client";

import QRCode from "qrcode";
import { useEffect, useRef, useState } from "react";
import { timeInSaoPaulo } from "@/lib/dates";
import { brl } from "@/lib/format";
import { pixPayload } from "@/lib/pix";
import type { PublicAppointment } from "@/lib/types";

/** Pede ao servidor para conferir a cobrança no provedor, liberar reserva vencida e fazer estorno pendente. */
export const syncPayment = (token: string) =>
  fetch("/api/pagamento/status", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token }),
  }).catch(() => null);

/**
 * Pagamento na página do agendamento.
 * - Cobrança ligada: Pix do provedor para o sinal, com prazo; a confirmação chega sozinha.
 * - Cobrança desligada: Pix "copia e cola" gerado da chave do estabelecimento, com confirmação manual do dono.
 */
export function PaymentPanel({ appointment, token, onChanged }: { appointment: PublicAppointment; token: string; onChanged: () => void }) {
  const { business } = appointment;
  const open = ["pending", "confirmed"].includes(appointment.status) && !appointment.is_past;
  const awaiting = appointment.payment_status === "awaiting" && appointment.status === "pending";
  const [code, setCode] = useState<string | null>(appointment.payment?.status === "pending" ? appointment.payment.pix_code : null);
  const [error, setError] = useState<string | null>(null);
  const changed = useRef(onChanged);
  useEffect(() => {
    changed.current = onChanged;
  }, [onChanged]);

  // Cobrança do provedor: cria (ou recupera) o Pix e fica conferindo até pagar ou vencer.
  useEffect(() => {
    if (!awaiting) return;
    let active = true;
    if (!appointment.hold_expired) {
      fetch("/api/pagamento/criar", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      })
        .then(async (response) => ({ ok: response.ok, body: await response.json().catch(() => ({})) }))
        .then(({ ok, body }) => {
          if (!active) return;
          if (ok) setCode(body.pix_code);
          else setError(body.error ?? "Não foi possível gerar o Pix agora.");
        })
        .catch(() => active && setError("Falha de conexão ao gerar o Pix."));
    }
    const tick = async () => {
      await syncPayment(token);
      if (active) changed.current();
    };
    const first = setTimeout(tick, appointment.hold_expired ? 0 : 4000);
    const interval = setInterval(tick, 5000);
    return () => {
      active = false;
      clearTimeout(first);
      clearInterval(interval);
    };
  }, [awaiting, appointment.hold_expired, token]);

  // Estorno pendente: pede ao servidor para concluir.
  useEffect(() => {
    if (appointment.payment_status !== "refund_pending") return;
    let active = true;
    syncPayment(token).then(() => active && changed.current());
    return () => {
      active = false;
    };
  }, [appointment.payment_status, token]);

  // Pix copia e cola da chave do estabelecimento (cobrança desligada): só para facilitar o pagamento.
  const manual =
    open && appointment.payment_status === "none" && !business.charge_on_booking && business.pix_key && appointment.deposit_cents > 0
      ? pixPayload({
          key: business.pix_key,
          amountCents: appointment.deposit_cents,
          merchantName: business.name,
          txid: token.replace(/-/g, "").slice(0, 25),
        })
      : null;

  if (awaiting) {
    return (
      <section className="card p-5" aria-live="polite">
        <h2 className="font-semibold">Pague o sinal para confirmar · {brl(appointment.deposit_cents)}</h2>
        {appointment.hold_expired ? (
          <p className="mt-1 text-sm text-stone-600">O prazo para pagar terminou. Liberando o horário...</p>
        ) : (
          <>
            <p className="mt-1 text-sm text-stone-600">
              Seu horário fica reservado até {appointment.hold_expires_at ? timeInSaoPaulo(appointment.hold_expires_at) : "o fim do prazo"}.
              Pague pelo Pix abaixo; a confirmação aparece aqui sozinha.
            </p>
            {error && <p role="alert" className="mt-2 text-sm text-red-700">{error}</p>}
            {code ? <PixCode code={code} label="QR code Pix do sinal" /> : !error && <p className="mt-3 text-sm text-stone-500">Gerando o Pix...</p>}
            <p className="mt-2 text-xs text-stone-500">
              Se você cancelar dentro do prazo de cancelamento, o sinal é devolvido. Sem pagamento até o horário acima, a reserva cai.
            </p>
          </>
        )}
      </section>
    );
  }

  if (appointment.payment_status === "paid") {
    return <Note tone="green">Sinal de {brl(appointment.deposit_cents)} pago. Obrigado!</Note>;
  }
  if (appointment.payment_status === "manual_paid") {
    return <Note tone="green">Pagamento confirmado por {business.name}.</Note>;
  }
  if (appointment.payment_status === "refund_pending") {
    return <Note tone="amber">O sinal de {brl(appointment.deposit_cents)} está sendo devolvido. O estorno pode levar alguns minutos para aparecer.</Note>;
  }
  if (appointment.payment_status === "refunded") {
    return <Note tone="stone">O sinal de {brl(appointment.deposit_cents)} foi devolvido.</Note>;
  }

  if (manual) {
    return (
      <section className="card p-5">
        <h2 className="font-semibold">Pagamento via Pix · {brl(appointment.deposit_cents)}</h2>
        <p className="mt-1 text-sm text-stone-600">
          Se quiser adiantar, aponte a câmera do app do seu banco para o QR code ou use o Pix copia e cola. O valor já vai preenchido.
        </p>
        <PixCode code={manual} label="QR code Pix" />
        <p className="mt-2 text-xs text-stone-500">
          Depois de pagar, envie o comprovante para {business.name}. A confirmação do pagamento é feita pelo estabelecimento.
        </p>
      </section>
    );
  }
  return null;
}

function Note({ tone, children }: { tone: "green" | "amber" | "stone"; children: React.ReactNode }) {
  const style = { green: "bg-green-50 text-green-900", amber: "bg-amber-50 text-amber-900", stone: "bg-stone-100 text-stone-700" }[tone];
  return <p role="status" className={`rounded-xl px-4 py-3 text-sm font-medium ${style}`}>{children}</p>;
}

function PixCode({ code, label }: { code: string; label: string }) {
  const [qr, setQr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    let active = true;
    QRCode.toDataURL(code, { margin: 1, width: 220 }).then((url) => active && setQr(url));
    return () => {
      active = false;
    };
  }, [code]);
  return (
    <>
      {qr && (
        // eslint-disable-next-line @next/next/no-img-element -- imagem gerada no aparelho
        <img src={qr} alt={label} width={220} height={220} className="mx-auto mt-3 rounded-lg border border-stone-200" />
      )}
      <div className="mt-3 flex gap-2">
        <code className="input flex-1 truncate" data-testid="pix-code">{code}</code>
        <button
          type="button"
          className="btn-outline"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(code);
              setCopied(true);
              setTimeout(() => setCopied(false), 2000);
            } catch {
              // Sem permissão para copiar: o código continua visível para copiar à mão.
            }
          }}
        >
          {copied ? "Copiado" : "Copiar"}
        </button>
      </div>
    </>
  );
}
