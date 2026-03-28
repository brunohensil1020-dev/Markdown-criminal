import zipfile
import pathlib
import os

downloads = pathlib.Path.home() / "Downloads"
test_zip = downloads / "teste_automacao.zip"
temp_dir = downloads / "temp_test"
temp_dir.mkdir(exist_ok=True)
(temp_dir / "check.txt").write_text("Automacao de Zip Funcionando!")

with zipfile.ZipFile(test_zip, 'w') as z:
    z.write(temp_dir / "check.txt", "check.txt")

print(f"Test ZIP created at {test_zip}")
