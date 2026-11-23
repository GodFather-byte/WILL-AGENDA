"use client";

import { useEffect, useState } from "react";
import { Modal } from "@/components/Modal";

// Tutorial de instalação na tela inicial. Descobre o aparelho (Android ou iPhone) e o navegador
// e mostra só os passos que valem para ele. No Android com Chrome, o botão instala direto.

type Platform = "android" | "ios" | "desktop";
type Device = {
  platform: Platform;
  /** Navegador embutido de outro app (Instagram, Facebook...): não instala, precisa abrir no navegador de verdade. */
  inApp: boolean;
  safari: boolean;
  samsung: boolean;
  /** Já aberto como app instalado. */
  standalone: boolean;
};

type InstallPromptEvent = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: "accepted" | "dismissed" }> };

export function detectDevice(userAgent: string, touchPoints: number, standalone: boolean): Device {
  const ua = userAgent;
  // iPad moderno se apresenta como Mac; a diferença é a tela de toque.
  const ios = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && touchPoints > 1);
  const android = /Android/.test(ua);
  const inApp = /Instagram|FBAN|FBAV|FB_IAB|Line\/|TikTok|musical_ly|Snapchat|; wv\)/.test(ua);
  return {
    platform: ios ? "ios" : android ? "android" : "desktop",
    inApp,
    safari: ios && /Safari\//.test(ua) && !/CriOS|FxiOS|EdgiOS|OPiOS/.test(ua) && !inApp,
    samsung: /SamsungBrowser/.test(ua),
    standalone,
  };
}

/** Estado da instalação neste aparelho. `device` é null até o navegador responder (nada aparece no servidor). */
export function useInstall() {
  const [device, setDevice] = useState<Device | null>(null);
  const [prompt, setPrompt] = useState<InstallPromptEvent | null>(null);

  useEffect(() => {
    const standalone =
      window.matchMedia("(display-mode: standalone)").matches ||
      (navigator as Navigator & { standalone?: boolean }).standalone === true;
    const first = setTimeout(() => setDevice(detectDevice(navigator.userAgent, navigator.maxTouchPoints, standalone)), 0);

    // O Chrome do Android avisa quando dá para instalar com um toque.
    const onPrompt = (event: Event) => {
      event.preventDefault();
      setPrompt(event as InstallPromptEvent);
    };
    const onInstalled = () => {
      setPrompt(null);
      setDevice((current) => (current ? { ...current, standalone: true } : current));
    };
    window.addEventListener("beforeinstallprompt", onPrompt);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      clearTimeout(first);
      window.removeEventListener("beforeinstallprompt", onPrompt);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  async function install() {
    if (!prompt) return false;
    await prompt.prompt();
    const choice = await prompt.userChoice;
    setPrompt(null);
    return choice.outcome === "accepted";
  }

  return { device, canPrompt: prompt !== null, install };
}

const ShareIcon = () => (
  <svg viewBox="0 0 24 24" className="inline h-5 w-5 align-text-bottom" fill="none" stroke="currentColor" strokeWidth="2"
    strokeLinecap="round" strokeLinejoin="round" aria-label="ícone de compartilhar" role="img">
    <path d="M12 15V3" />
    <path d="m7 8 5-5 5 5" />
    <path d="M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7" />
  </svg>
);

const DotsIcon = () => (
  <svg viewBox="0 0 24 24" className="inline h-5 w-5 align-text-bottom" fill="currentColor" aria-label="ícone de três pontinhos" role="img">
    <circle cx="12" cy="5" r="2" />
    <circle cx="12" cy="12" r="2" />
    <circle cx="12" cy="19" r="2" />
  </svg>
);

function Steps({ children }: { children: React.ReactNode[] }) {
  return (
    <ol className="space-y-3">
      {children.map((step, index) => (
        <li key={index} className="flex gap-3 text-sm">
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-brand text-sm font-bold text-brand-fg">
            {index + 1}
          </span>
          <span className="pt-0.5 leading-snug">{step}</span>
        </li>
      ))}
    </ol>
  );
}

function IosSteps({ device, appName }: { device: Device; appName: string }) {
  if (device.platform === "ios" && device.inApp) {
    return (
      <Steps>
        {[
          <>Você está dentro de outro aplicativo. Toque em <strong>⋯</strong> (ou no ícone de bússola) e escolha <strong>Abrir no Safari</strong>.</>,
          <>No Safari, toque em <ShareIcon /> <strong>Compartilhar</strong>, na barra de baixo.</>,
          <>Role a lista e toque em <strong>Adicionar à Tela de Início</strong>, depois em <strong>Adicionar</strong>.</>,
        ]}
      </Steps>
    );
  }
  const where = device.platform === "ios" && !device.safari ? "ao lado do endereço, no alto da tela" : "na barra de baixo do Safari";
  return (
    <Steps>
      {[
        <>Toque em <ShareIcon /> <strong>Compartilhar</strong>, {where}.</>,
        <>Role a lista para baixo e toque em <strong>Adicionar à Tela de Início</strong>.</>,
        <>Confira o nome “{appName}” e toque em <strong>Adicionar</strong>, no canto de cima.</>,
        <>Pronto: o ícone aparece na tela inicial. Abra por ele, como qualquer aplicativo.</>,
      ]}
    </Steps>
  );
}

function AndroidSteps({ device }: { device: Device }) {
  if (device.platform === "android" && device.inApp) {
    return (
      <Steps>
        {[
          <>Você está dentro de outro aplicativo. Toque em <DotsIcon /> e escolha <strong>Abrir no Chrome</strong>.</>,
          <>No Chrome, toque em <DotsIcon />, no canto de cima.</>,
          <>Toque em <strong>Adicionar à tela inicial</strong> (ou <strong>Instalar app</strong>) e confirme em <strong>Instalar</strong>.</>,
        ]}
      </Steps>
    );
  }
  if (device.samsung) {
    return (
      <Steps>
        {[
          <>Toque no menu <strong>☰</strong>, na barra de baixo do navegador Samsung.</>,
          <>Toque em <strong>Adicionar página a</strong> e escolha <strong>Tela inicial</strong>.</>,
          <>Confirme em <strong>Adicionar</strong>. O ícone aparece na tela inicial.</>,
        ]}
      </Steps>
    );
  }
  return (
    <Steps>
      {[
        <>Toque em <DotsIcon />, no canto de cima do Chrome.</>,
        <>Toque em <strong>Adicionar à tela inicial</strong> (em alguns aparelhos aparece <strong>Instalar app</strong>).</>,
        <>Confirme em <strong>Instalar</strong>.</>,
        <>Pronto: o ícone aparece na tela inicial. Abra por ele, como qualquer aplicativo.</>,
      ]}
    </Steps>
  );
}

export function InstallGuide({
  appName,
  device,
  canPrompt,
  onInstall,
  onClose,
}: {
  appName: string;
  device: Device;
  canPrompt: boolean;
  onInstall: () => Promise<boolean>;
  onClose: () => void;
}) {
  // No computador não há o que detectar: a pessoa escolhe o celular que vai usar.
  const [tab, setTab] = useState<"android" | "ios">(device.platform === "ios" ? "ios" : "android");
  const [installed, setInstalled] = useState(false);
  const detected = device.platform === "desktop" ? null : device.platform === "ios" ? "iPhone" : "Android";

  const pill = (active: boolean) =>
    `flex-1 rounded-lg border px-3 py-2.5 text-sm font-semibold ${
      active ? "border-brand bg-brand/10 text-stone-900" : "border-stone-300 text-stone-600"
    }`;

  return (
    <Modal title="Instalar no celular" onClose={onClose}>
      <div className="space-y-5">
        {device.standalone || installed ? (
          <p className="rounded-lg bg-green-50 px-3 py-3 text-sm font-medium text-green-900">
            O app já está instalado neste aparelho. É só abrir pelo ícone “{appName}” na tela inicial.
          </p>
        ) : (
          <>
            <p className="text-sm text-stone-600">
              {detected
                ? `Detectamos que você está em um ${detected}. Siga os passos abaixo e “${appName}” vira um aplicativo na sua tela inicial.`
                : `Abra este mesmo endereço no celular para instalar “${appName}” como aplicativo. Veja como fazer em cada aparelho:`}
            </p>

            {canPrompt && tab === "android" && (
              <button type="button" className="btn-primary w-full py-3.5 text-base"
                onClick={async () => setInstalled(await onInstall())}>
                Instalar agora
              </button>
            )}

            <div className="flex gap-2" role="group" aria-label="Tipo de celular">
              <button type="button" aria-pressed={tab === "android"} className={pill(tab === "android")} onClick={() => setTab("android")}>
                Android
              </button>
              <button type="button" aria-pressed={tab === "ios"} className={pill(tab === "ios")} onClick={() => setTab("ios")}>
                iPhone
              </button>
            </div>

            {canPrompt && tab === "android" && (
              <p className="text-xs text-stone-500">Se o botão acima não abrir nada, faça pelo menu:</p>
            )}
            {tab === "ios" ? <IosSteps device={device} appName={appName} /> : <AndroidSteps device={device} />}
          </>
        )}
        <button type="button" className="btn-outline w-full" onClick={onClose}>Fechar</button>
      </div>
    </Modal>
  );
}

/**
 * Convite para instalar. `banner` aparece sozinho (some depois de dispensado ou de instalado);
 * `button` é um atalho fixo, para quem quiser ver o tutorial de novo.
 */
export function InstallPrompt({
  appName,
  storageKey,
  variant,
  className = "",
}: {
  appName: string;
  storageKey: string;
  variant: "banner" | "button" | "link";
  className?: string;
}) {
  const { device, canPrompt, install } = useInstall();
  const [open, setOpen] = useState(false);
  const [dismissed, setDismissed] = useState(true);

  useEffect(() => {
    const first = setTimeout(() => {
      try {
        setDismissed(localStorage.getItem(storageKey) === "1");
      } catch {
        setDismissed(false);
      }
    }, 0);
    return () => clearTimeout(first);
  }, [storageKey]);

  function dismiss() {
    setDismissed(true);
    try {
      localStorage.setItem(storageKey, "1");
    } catch {
      // Sem armazenamento: some só até recarregar.
    }
  }

  if (!device) return null;
  const guide = open && (
    <InstallGuide appName={appName} device={device} canPrompt={canPrompt} onInstall={install} onClose={() => setOpen(false)} />
  );

  if (variant === "button" || variant === "link") {
    if (device.standalone && variant === "link") return null;
    return (
      <>
        <button type="button" onClick={() => setOpen(true)}
          className={variant === "button" ? `btn-outline ${className}` : `text-sm font-semibold text-brand underline ${className}`}>
          {device.standalone ? "App instalado neste aparelho" : "Instalar no celular"}
        </button>
        {guide}
      </>
    );
  }

  // Banner: só no celular, fora do app instalado, até a pessoa dispensar.
  if (device.standalone || device.platform === "desktop" || dismissed) return guide || null;
  return (
    <>
      <div className={`flex items-center gap-3 rounded-xl border border-stone-200 bg-white px-3 py-2.5 print:hidden ${className}`}>
        <p className="min-w-0 flex-1 text-sm">
          <span className="font-semibold">Instale o app no seu {device.platform === "ios" ? "iPhone" : "Android"}</span>
          <span className="block text-xs text-stone-500">Abre em tela cheia, direto da tela inicial.</span>
        </p>
        <button type="button" className="btn-primary shrink-0 py-2" onClick={() => setOpen(true)}>Ver como</button>
        <button type="button" aria-label="Dispensar" className="shrink-0 px-1 text-stone-400" onClick={dismiss}>✕</button>
      </div>
      {guide}
    </>
  );
}
