"use client";

/* eslint-disable @next/next/no-img-element -- logotipo vem do Storage já reduzido */

import { useRef, useState } from "react";
import { resizeImage, uploadBrandImage } from "@/lib/image";
import { createClient } from "@/lib/supabase/client";
import { useBusiness } from "./BusinessContext";

// Logotipo: aparece na página pública, no painel e vira o ícone do app instalado no celular.
export function LogoUpload() {
  const { business, setBusiness } = useBusiness();
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(logoUrl: string | null) {
    const { error } = await createClient().from("businesses").update({ logo_url: logoUrl }).eq("id", business.id);
    if (error) throw new Error(error.message);
    setBusiness({ ...business, logo_url: logoUrl });
  }

  async function pick(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const supabase = createClient();
      // Quadrado com fundo branco, nos dois tamanhos que o celular pede para o ícone do app.
      const [big, small] = await Promise.all([
        resizeImage(file, { size: 512, square: true, type: "image/png" }),
        resizeImage(file, { size: 192, square: true, type: "image/png" }),
      ]);
      await uploadBrandImage(supabase, business.id, "logo-192.png", small);
      await save(await uploadBrandImage(supabase, business.id, "logo.png", big));
    } catch {
      setError("Não foi possível enviar o logotipo. Use uma imagem PNG ou JPG e confira a conexão.");
    }
    setBusy(false);
  }

  async function remove() {
    setBusy(true);
    setError(null);
    try {
      await save(null);
    } catch {
      setError("Não foi possível remover o logotipo.");
    }
    setBusy(false);
  }

  return (
    <div className="flex items-center gap-4">
      <div className="flex h-20 w-20 shrink-0 items-center justify-center overflow-hidden rounded-xl border border-stone-200 bg-white text-xs text-stone-400">
        {business.logo_url ? <img src={business.logo_url} alt={`Logotipo de ${business.name}`} className="h-full w-full object-contain" /> : "Sem logo"}
      </div>
      <div className="min-w-0 flex-1 space-y-1.5">
        <p className="text-sm font-medium text-stone-700">Logotipo</p>
        <p className="text-xs text-stone-500">Aparece na sua página, no painel e como ícone do app no celular.</p>
        <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp" className="hidden" aria-label="Arquivo do logotipo" onChange={pick} />
        <div className="flex flex-wrap gap-2">
          <button type="button" className="btn-outline py-2" disabled={busy} onClick={() => fileRef.current?.click()}>
            {busy ? "Enviando..." : business.logo_url ? "Trocar logotipo" : "Enviar logotipo"}
          </button>
          {business.logo_url && (
            <button type="button" className="btn-ghost py-2" disabled={busy} onClick={remove}>Remover</button>
          )}
        </div>
        {error && <p role="alert" className="text-xs text-red-700">{error}</p>}
      </div>
    </div>
  );
}
