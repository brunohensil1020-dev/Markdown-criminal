import os
import shutil
import argparse

def triagem(pasta_origem, pasta_destino=None):
    # Termos que definem o que é "Lixo Burocrático" (ignorar)
    termos_ignorar = ["CERTIDÃO (OUTRAS)", "ATO ORDINATÓRIO", "CERTIDÃO DE PUBLICAÇÃO"]

    # Termos que definem o que é "Ouro" (prioridade)
    termos_ouro = ["PETIÇÃO", "INQUÉRITO", "TERMO", "LAUDO", "SENTENÇA", "ALEGAÇÕES", "MANIFESTAÇÃO"]

    if pasta_destino is None:
        pasta_destino = os.path.join(pasta_origem, "PARA_ANALISE")

    if not os.path.exists(pasta_destino):
        os.makedirs(pasta_destino)

    count = 0
    for arquivo in os.listdir(pasta_origem):
        nome_up = arquivo.upper()
        
        # Regra de Ouro: Só move se for PDF e contiver termos relevantes
        if nome_up.endswith(".PDF"):
            if any(termo in nome_up for termo in termos_ouro) and not any(termo in nome_up for termo in termos_ignorar):
                shutil.copy(os.path.join(pasta_origem, arquivo), pasta_destino)
                print(f"✅ Selecionado: {arquivo}")
                count += 1

    print(f"\n🚀 Triagem concluída! {count} arquivos prontos em: {pasta_destino}")

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Triagem de processos jurídicos.")
    parser.add_argument("pasta", help="Caminho da pasta do processo")
    args = parser.parse_args()
    
    if os.path.exists(args.pasta):
        triagem(args.pasta)
    else:
        print(f"Erro: Pasta {args.pasta} não encontrada.")
