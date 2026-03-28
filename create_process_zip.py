import zipfile
import pathlib
import os

downloads = pathlib.Path.home() / "Downloads"
# Padrão de processo legal brasileiro
process_num = "0901692-96.2024.8.12.0021"
test_zip = downloads / f"{process_num}.zip"

# Criar arquivos de teste
temp_dir = downloads / "temp_process_test"
temp_dir.mkdir(exist_ok=True)

(temp_dir / "PETICAO_INICIAL.pdf").write_text("Conteudo de Ouro")
(temp_dir / "CERTIDAO_DE_PUBLICACAO.pdf").write_text("Lixo Burocratico")
(temp_dir / "SENTENCA_FINAL.pdf").write_text("Mais Ouro")
(temp_dir / "OUTRO_ARQUIVO.txt").write_text("Nao eh PDF")

with zipfile.ZipFile(test_zip, 'w') as z:
    z.write(temp_dir / "PETICAO_INICIAL.pdf", "PETICAO_INICIAL.pdf")
    z.write(temp_dir / "CERTIDAO_DE_PUBLICACAO.pdf", "CERTIDAO_DE_PUBLICACAO.pdf")
    z.write(temp_dir / "SENTENCA_FINAL.pdf", "SENTENCA_FINAL.pdf")
    z.write(temp_dir / "OUTRO_ARQUIVO.txt", "OUTRO_ARQUIVO.txt")

print(f"Test Process ZIP created at {test_zip}")
