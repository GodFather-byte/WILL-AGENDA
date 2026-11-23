import Link from "next/link";

export default function NotFound() {
  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-3 px-5 text-center">
      <h1 className="text-2xl font-bold">Página não encontrada</h1>
      <p className="max-w-sm text-sm text-stone-600">
        Confira se o endereço está certo. Se você recebeu este link de um estabelecimento, peça o endereço de novo.
      </p>
      <Link href="/" className="btn-outline">
        Ir para o início
      </Link>
    </main>
  );
}
