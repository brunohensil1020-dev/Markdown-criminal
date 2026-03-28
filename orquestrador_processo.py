import os
import re
import fitz
from segmentar_processo import classificar_pagina
from pdf_utils import extrair_data_assinatura_magistrado, gerar_relatorio_word

class NeuralCriminalOrquestrador:
    """
    Orquestra o processamento de múltiplos PDFs extraídos de um ZIP do e-SAJ.
    Garante a ordem cronológica baseada no número das folhas.
    """
    def __init__(self, pasta_arquivos):
        self.pasta = pasta_arquivos
        if not os.path.exists(self.pasta):
            os.makedirs(self.pasta, exist_ok=True)
            print(f"Aviso: Pasta {self.pasta} criada. Coloque os PDFs nela.")
        
        self.arquivos_ordenados = self._mapear_e_ordenar()

    def _mapear_e_ordenar(self):
        lista_final = []
        # Regex para capturar 'pag 123' ou 'folha 123' no nome do arquivo
        padrao_pag = re.compile(r"(?:pag|fls|folha)\s*(\d+)", re.IGNORECASE)
        
        try:
            arquivos = [f for f in os.listdir(self.pasta) if f.lower().endswith(".pdf")]
        except FileNotFoundError:
            return []

        for nome in arquivos:
            match = padrao_pag.search(nome)
            # Se não achar número, coloca no final (pág 99999)
            pagina = int(match.group(1)) if match else 99999
            lista_final.append({"nome": nome, "pagina": pagina})
        
        # Ordena pela folha original do processo
        return sorted(lista_final, key=lambda x: x['pagina'])

    def identificar_prioridade_pelo_nome(self, nome_arquivo):
        """Identificação rápida baseada no nome do arquivo."""
        nome = nome_arquivo.upper()
        if "PETIÇÃO" in nome: return "PEÇA_INICIAL"
        if "INQUÉRITO" in nome: return "CAPA_INVESTIGAÇÃO"
        if "TERMO" in nome: return "DEPOIMENTO_OU_INTERROGATÓRIO"
        if "CERTIDÃO" in nome: return "CERTIDÃO_CARTORÁRIA"
        if "LAUDO" in nome: return "LAUDO_PERICIAL"
        return "OUTROS"

    def analisar_processo(self):
        relatorio_geral = []
        print(f"Iniciando análise de {len(self.arquivos_ordenados)} arquivos em '{self.pasta}'...")
        
        for item in self.arquivos_ordenados:
            caminho = os.path.join(self.pasta, item['nome'])
            
            # 1. Análise pelo Nome
            prioridade = self.identificar_prioridade_pelo_nome(item['nome'])
            
            # 2. Análise Profunda do Conteúdo (Página 1 de cada arquivo)
            try:
                # Extração de Data de Assinatura
                data_assinatura, pag_assinatura = extrair_data_assinatura_magistrado(caminho)
                
                doc = fitz.open(caminho)
                if len(doc) > 0:
                    header = doc[0].get_text().upper()[:900]
                    tipo_conteudo, personagem = classificar_pagina(header)
                else:
                    tipo_conteudo, personagem = "ARQUIVO_VAZIO", "N/A"
                doc.close()
            except Exception as e:
                data_assinatura = "ERRO"
                tipo_conteudo, personagem = f"ERRO_LEITURA: {str(e)}", "N/A"

            resultado = {
                "folha": item['pagina'],
                "arquivo": item['nome'],
                "data_assinatura": data_assinatura,
                "tipo_nome": prioridade,
                "tipo_conteudo": tipo_conteudo,
                "personagem": personagem
            }
            relatorio_geral.append(resultado)
            
        return relatorio_geral

if __name__ == "__main__":
    # Pasta de exemplo (ajuste conforme necessário)
    pasta_investigacao = "./seu_zip_extraido"
    
    orquestrador = NeuralCriminalOrquestrador(pasta_investigacao)
    resultados = orquestrador.analisar_processo()
    
    if resultados:
        print("\n" + "="*90)
        print(f"{'FLS':<6} | {'DATA':<12} | {'TIPO (NOME)':<20} | {'CONTEÚDO':<20} | {'PERSONAGEM':<20}")
        print("-" * 90)
        for r in resultados:
            print(f"{r['folha']:<6} | {r['data_assinatura']:<12} | {r['tipo_nome']:<20} | {r['tipo_conteudo']:<20} | {r['personagem']:<20}")
        print("="*90)
        
        # Gera o relatório Word automaticamente
        nome_relatorio = os.path.join(pasta_investigacao, "Relatorio_Auditoria.docx")
        gerar_relatorio_word(resultados, nome_relatorio)
    else:
        print("Nenhum arquivo PDF encontrado na pasta para processar.")
