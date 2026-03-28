import os
from PyPDF2 import PdfMerger

# --- CONFIGURAÇÕES ---
# Pasta onde estão os seus 91 PDFs fragmentados
pasta_origem = './' # './' significa a pasta atual onde o script está
arquivo_final = 'INQUERITO_COMPLETO_LIMPO.pdf'

# Tamanho mínimo (em bytes) para considerar o arquivo (20KB)
tamanho_minimo_bytes = 20 * 1024 

# Palavras-chave para IGNORAR (filtros markdown e burocráticos)
palavras_ignoradas = ['CAPA', 'CERTIDAO', 'MANDADO', 'CITACAO', 'PROTOCOLO', 'AR_RECEBIDO', 'ATO_ORDINATORIO']

# --- INÍCIO DO PROCESSO ---
def processar_arquivos():
    merger = PdfMerger()
    arquivos_incluidos = []
    
    # 1. Lista e Ordena os arquivos para manter a cronologia
    lista_arquivos = sorted([f for f in os.listdir(pasta_origem) if f.endswith('.pdf')])
    
    print(f"🔍 Iniciando varredura em {len(lista_arquivos)} arquivos...")

    for arquivo in lista_arquivos:
        # Pula o próprio arquivo final se ele já existir
        if arquivo == arquivo_final:
            continue
            
        caminho_completo = os.path.join(pasta_origem, arquivo)
        tamanho = os.path.getsize(caminho_completo)
        nome_upper = arquivo.upper()

        # --- APLICAÇÃO DOS FILTROS (A MAGIA ACONTECE AQUI) ---
        
        # Filtro 1: Tamanho (Elimina arquivos vazios/de assinatura/burocracia extrema)
        if tamanho < tamanho_minimo_bytes:
            # print(f"⚠️ Ignorado por tamanho ({tamanho/1024:.1f}KB): {arquivo}")
            continue

        # Filtro 2: Palavras-chave (Elimina burocracia)
        ignorar = False
        for palavra in palavras_ignoradas:
            if palavra in nome_upper:
                ignorar = True
                break
        
        if ignorar:
            # print(f"⚠️ Ignorado por filtro de nome: {arquivo}")
            continue

        # --- SE PASSOU PELOS FILTROS, ADICIONA ---
        try:
            print(f"✅ Incluindo: {arquivo} ({tamanho/1024:.1f}KB)")
            merger.append(caminho_completo)
            arquivos_incluidos.append(arquivo)
        except Exception as e:
            print(f"❌ Erro ao ler {arquivo}: {e}")

    # 2. Salva o arquivo final
    if arquivos_incluidos:
        print(f"\n💾 Salvando arquivo final com {len(arquivos_incluidos)} documentos unidos...")
        merger.write(arquivo_final)
        merger.close()
        print(f"✨ CONCLUÍDO! Arquivo gerado: {arquivo_final}")
    else:
        print("❌ Nenhum arquivo passou pelos filtros. Verifique a pasta.")

if __name__ == "__main__":
    processar_arquivos()
