import { Customers } from "@/components/painel/Customers";

// Painel é sempre por requisição (sessão do dono): fora da validação de navegação instantânea.
export const instant = false;

export default function Page() {
  return <Customers />;
}
