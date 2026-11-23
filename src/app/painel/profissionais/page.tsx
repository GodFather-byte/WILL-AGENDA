import { ProfessionalsManager } from "@/components/painel/ProfessionalsManager";

// Painel é sempre por requisição (sessão do dono): fora da validação de navegação instantânea.
export const instant = false;

export default function Page() {
  return <ProfessionalsManager />;
}
