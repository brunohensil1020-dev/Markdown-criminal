import os
import time
import zipfile
from pathlib import Path
from watchdog.observers import Observer
from watchdog.events import FileSystemEventHandler
import re
from triagem_processo import triagem
from orquestrador_processo import NeuralCriminalOrquestrador

# Configuração da pasta de Downloads
DOWNLOADS_DIR = str(Path.home() / "Downloads")

class ZipHandler(FileSystemEventHandler):
    def __init__(self):
        super().__init__()
        self.processed_files = set()

    def on_created(self, event):
        print(f"[DEBUG] Evento on_created: {event.src_path}")
        # Monitora novos arquivos e arquivos movidos para a pasta
        if not event.is_directory and event.src_path.lower().endswith('.zip'):
            self.process_zip(event.src_path)

    def on_moved(self, event):
        print(f"[DEBUG] Evento on_moved de {event.src_path} para {event.dest_path}")
        if not event.is_directory and event.dest_path.lower().endswith('.zip'):
            self.process_zip(event.dest_path)
            
    def on_modified(self, event):
        if not event.is_directory and event.src_path.lower().endswith('.zip'):
            print(f"[DEBUG] Evento on_modified: {event.src_path}")
            if event.src_path not in self.processed_files:
                self.process_zip(event.src_path)
            
    def process_zip(self, zip_path):
        zip_path = Path(zip_path)
        # Cria uma pasta com o mesmo nome do arquivo zip
        extract_dir = zip_path.parent / zip_path.stem
        
        print(f"[-] Arquivo detectado: {zip_path.name}")
        
        # Aguarda o arquivo ser totalmente gravado (evita erro de permissão durante o download)
        max_retries = 10
        for i in range(max_retries):
            try:
                # Tenta abrir o ZIP para verificar se está pronto
                with zipfile.ZipFile(zip_path, 'r') as zip_ref:
                    if not extract_dir.exists():
                        extract_dir.mkdir(parents=True, exist_ok=True)
                    zip_ref.extractall(extract_dir)
                print(f"[+] Extraído com sucesso para: {extract_dir}")
                
                # Opcional: Se a pasta parecer um processo legal, rodar a triagem
                if re.match(r'^\d{7}-\d{2}\.\d{4}', extract_dir.name):
                    print(f"[*] Detectado padrão de processo. Iniciando triagem...")
                    triagem(str(extract_dir))
                    
                    # Novo: Iniciar Auditoria Neural Automática na pasta selecionada (PARA_ANALISE)
                    pasta_triagem = os.path.join(str(extract_dir), "PARA_ANALISE")
                    if os.path.exists(pasta_triagem):
                        print(f"[*] Iniciando Auditoria Neural Criminal...")
                        orquestrador = NeuralCriminalOrquestrador(pasta_triagem)
                        orquestrador.analisar_processo()
                
                break
            except (PermissionError, zipfile.BadZipFile, OSError):
                if i < max_retries - 1:
                    time.sleep(2) # Aguarda 2 segundos antes de tentar novamente
                else:
                    print(f"[!] Erro ao extrair {zip_path.name}: O arquivo pode estar corrompido ou sendo usado por outro processo.")

if __name__ == "__main__":
    if not os.path.exists(DOWNLOADS_DIR):
        print(f"[!] Erro: A pasta {DOWNLOADS_DIR} não foi encontrada.")
        exit(1)

    event_handler = ZipHandler()
    observer = Observer()
    observer.schedule(event_handler, DOWNLOADS_DIR, recursive=False)
    observer.start()
    
    print(f"[*] Automação iniciada. Monitorando: {DOWNLOADS_DIR}")
    print("[*] Pressione Ctrl+C para encerrar.")
    
    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        observer.stop()
    observer.join()
