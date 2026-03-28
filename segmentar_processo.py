import fitz  # PyMuPDF
import os
import re

def extrair_identidade(text_header, tipo):
    """
    Extrai o nome do personagem/entidade associado ao tipo de documento.
    """
    text = text_header.upper()
    personagem = "N/A"

    if tipo == "DEPOIMENTO":
        if "COMPARECEU:" in text:
            # Extrai após 'COMPARECEU:' até (, , ou \n
            parte = text.split("COMPARECEU:")[1]
            personagem = re.split(r'[(,\n]', parte)[0].strip()
    
    elif tipo == "LAUDO_PERICIAL":
        if "NOME:" in text:
            parte = text.split("NOME:")[1]
            personagem = parte.split("\n")[0].strip()
            
    return personagem

def classificar_pagina(text_header):
    """
    Classifica uma página individual e identifica personagens se aplicável.
    """
    text = text_header.upper()
    tipo = "OUTROS/ANEXOS"
    
    if "DENÚNCIA" in text and "MINISTÉRIO PÚBLICO" in text:
        tipo = "DENUNCIA"
    elif "LAUDO DE EXAME" in text or "SEXOLOGIA FORENSE" in text:
        tipo = "LAUDO_PERICIAL"
    elif "TERMO DE DEPOIMENTO" in text:
        tipo = "DEPOIMENTO"
    elif "OCORRÊNCIA Nº" in text and "POLÍCIA CIVIL" in text:
        tipo = "BOLETIM_OCORRENCIA"
    elif "MEDIDAS PROTETIVAS" in text:
        tipo = "MEDIDAS_PROTETIVAS"
    elif "SENTENÇA" in text or "ISTO POSTO" in text:
        tipo = "SENTENCA"
    elif "TERMO DE AUDIÊNCIA" in text:
        tipo = "TERMO_AUDIENCIA"

    personagem = extrair_identidade(text_header, tipo)
    return tipo, personagem

def segmentar_e_classificar(pdf_path):
    """
    Analisa o PDF para identificar peças (segmentação), classificar páginas e extrair identidades.
    """
    if not os.path.exists(pdf_path):
        print(f"Erro: O arquivo '{pdf_path}' não foi encontrado.")
        return [], {}

    doc = fitz.open(pdf_path)
    pecas_identificadas = []
    mapa_paginas = {}

    # 1. TOC (Prioridade para Segmentação)
    toc = doc.get_toc()
    if toc:
        for nivel, titulo, pagina in toc:
            pecas_identificadas.append({
                "metodo": "TOC",
                "tipo": titulo,
                "pagina": pagina,
                "personagem": "N/A"
            })

    # 2. Classificação de Páginas (Varredura Completa)
    print(f"Processando {len(doc)} páginas...")
    for page_num in range(len(doc)):
        page = doc.load_page(page_num)
        header_text = page.get_text().upper()[:900]
        
        tipo_pagina, personagem = classificar_pagina(header_text)
        mapa_paginas[page_num + 1] = {"tipo": tipo_pagina, "personagem": personagem}

        # Fallback de segmentação se o TOC falhar
        if not toc:
            if tipo_pagina != "OUTROS/ANEXOS":
                # Verifica se é uma nova peça (mudança de tipo ou personagem)
                prev_info = mapa_paginas.get(page_num, {"tipo": "", "personagem": ""})
                if tipo_pagina != prev_info["tipo"] or (personagem != "N/A" and personagem != prev_info["personagem"]):
                    pecas_identificadas.append({
                        "metodo": "Header-Scan",
                        "tipo": tipo_pagina,
                        "pagina": page_num + 1,
                        "personagem": personagem
                    })

    return pecas_identificadas, mapa_paginas

if __name__ == "__main__":
    arquivo_pdf = "processo teste 40.pdf" 
    
    if os.path.exists(arquivo_pdf):
        print(f"\n--- Analisando: {arquivo_pdf} ---")
        segmentos, mapa = segmentar_e_classificar(arquivo_pdf)
        
        print("\n[Segmentação e Identidades]")
        for s in segmentos:
            detalhe = f" | Personagem: {s['personagem']}" if s['personagem'] != "N/A" else ""
            print(f"Página {s['pagina']}: {s['tipo']} ({s['metodo']}){detalhe}")
            
        print("\n[Resumo de Classificação]")
        contagem = {}
        for info in mapa.values():
            t = info["tipo"]
            contagem[t] = contagem.get(t, 0) + 1
        for t, qtd in contagem.items():
            print(f"- {t}: {qtd} páginas")
    else:
        print(f"\nArquivo não encontrado: {arquivo_pdf}")
