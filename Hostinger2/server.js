const express = require('express');
const multer = require('multer');
const pdf = require('pdf-parse');
const cors = require('cors');

const app = express();

// Permite que o seu site (visioncriminal.com) acesse esta API
app.use(cors());

// Configuração para receber o arquivo PDF na memória (rápido)
const upload = multer({ storage: multer.memoryStorage() });

app.post('/analisar', upload.single('file'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ erro: "Nenhum arquivo detectado." });
        }

        // Lê o conteúdo do PDF
        const data = await pdf(req.file.buffer);
        const textoCompleto = data.text;

        // Lógica de extração inicial (Nome do Réu e Processo)
        // Aqui simulamos a extração para o relatório aparecer na tela
        const resultado = {
            status: "sucesso",
            detalhes: {
                reu: "NOME EXTRAÍDO DO PDF", 
                recebimento_denuncia: new Date().toLocaleDateString(),
                fatos: textoCompleto.substring(0, 600) + "...", 
                conclusao: "AUDITORIA CONCLUÍDA COM SUCESSO NO NODE.JS."
            }
        };

        res.json(resultado);

    } catch (error) {
        console.error("Erro no processamento:", error);
        res.status(500).json({ erro: "Falha ao ler o PDF no servidor." });
    }
});

// A Hostinger define a porta, ou usa a 3000
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Motor Criminal Ativo na Porta ${PORT}`);
});
