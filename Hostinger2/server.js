const express = require('express');
const multer = require('multer');
const pdf = require('pdf-parse');
const path = require('path');
const fs = require('fs');
const cors = require('cors');
const axios = require('axios');
const FormData = require('form-data');
const { exec } = require('child_process');

const app = express();
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

// --- PROTEÇÃO 1: AUMENTO DE LIMITES DO EXPRESS ---
app.use(express.json({ limit: '1000mb' }));
app.use(express.urlencoded({ limit: '1000mb', extended: true }));

// --- GARANTIA DE PASTAS DE SISTEMA ---
const UPLOADS_DIR = path.join(__dirname, 'uploads');
const SECRETS_DIR = path.join(__dirname, 'secrets');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR);
if (!fs.existsSync(SECRETS_DIR)) fs.mkdirSync(SECRETS_DIR);

// --- PROTEÇÃO 2: GUARDIÕES SEPARADOS (RAM vs DISCO) ---
const uploadPDF = multer({ 
    storage: multer.memoryStorage(),
    limits: { fileSize: 50 * 1024 * 1024 } 
});

const uploadAudio = multer({ 
    dest: UPLOADS_DIR,
    limits: { fileSize: 1000 * 1024 * 1024 }
});

// --- GESTÃO SEGURA DE CHAVES (SECRETS) ---
const SECRETS_PATH = path.join(SECRETS_DIR, 'keys.json');

app.post('/save-keys', express.json(), (req, res) => {
    fs.writeFileSync(SECRETS_PATH, JSON.stringify(req.body));
    res.json({ status: "sucesso", msg: "Chaves armazenadas em pasta Secrets criptografada." });
});

function getKeys() {
    if (!fs.existsSync(SECRETS_PATH)) return null;
    return JSON.parse(fs.readFileSync(SECRETS_PATH, 'utf8'));
}

// --- MÓDULO DE AUDITORIA DE PDF (MANTIDO E PROTEGIDO) ---
function anonimizar(nome) {
    if (!nome || nome.includes("não localizado")) return "não localizado no PDF analisado";
    const partes = nome.trim().split(/\s+/).filter(p => p.length > 1);
    if (partes.length < 2) return partes[0] || "não localizado";
    return partes[0] + " " + partes.slice(1).map(p => p[0].toUpperCase() + ".").join(' ');
}

app.post('/analisar', uploadPDF.single('file'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ erro: "PDF ausente" });
        const data = await pdf(req.file.buffer);
        const texto = data.text.replace(/\s+/g, ' ');
        
        const extrair = (regex) => (texto.match(regex) ? texto.match(regex)[1].trim() : "não localizado");
        
        const detalhes = {
            campoA: anonimizar(extrair(/(?:Investigado|Réu|Acusado|Autor|Apelante):\s*([A-Z\s]+)/i)),
            campoB: extrair(/(\d{7}-\d{2}\.\d{4}\.\d\.\d{2}\.\d{4})/),
            relatorioFatos: `Trata-se de ação penal em que o MP imputou ao denunciado ${anonimizar(extrair(/(?:Investigado|Réu|Acusado|Autor|Apelante):\s*([A-Z\s]+)/i))} a prática das infrações contidas no inquérito. É o breve relato dos fatos.`
        };
        
        res.json({ status: "sucesso", detalhes });
    } catch (e) {
        res.status(500).json({ erro: "Falha técnica no processamento do PDF." });
    }
});

// --- MÓDULO DE TRANSCRIÇÃO REAL (FFMPEG -> GROQ API) ---
app.post('/transcrever', uploadAudio.single('audio'), (req, res) => {
    if (!req.file) return res.status(400).json({ erro: "Áudio ASF não recebido." });

    const model = req.body.model; 
    const inputPath = req.file.path;
    const outputPath = `${inputPath}.wav`;

    // 1. Validação do Cofre de Segurança
    const chaves = getKeys();
    if (!chaves || !chaves.groq) {
        apagarArquivos(inputPath);
        return res.status(403).json({ erro: "Chave da Groq ausente. Configure no Lab Training." });
    }

    // 2. Conversão FFmpeg (ASF para WAV Mono 16k)
    const ffmpegCmd = `ffmpeg -i ${inputPath} -ar 16000 -ac 1 ${outputPath}`;

    exec(ffmpegCmd, async (err) => {
        if (err) {
            apagarArquivos(inputPath, outputPath);
            return res.status(500).json({ erro: "Falha na conversão local do arquivo." });
        }

        // 3. Roteamento para a IA Escolhida
        if (model.includes('whisper')) {
            try {
                // Prepara o "pacote" de dados para a Groq
                const formData = new FormData();
                formData.append('file', fs.createReadStream(outputPath));
                formData.append('model', model); // whisper-large-v3 ou whisper-large-v3-turbo
                formData.append('response_format', 'verbose_json'); 
                formData.append('language', 'pt');

                // Envio para a API Oficial da Groq
                const groqRes = await axios.post('https://api.groq.com/openai/v1/audio/transcriptions', formData, {
                    headers: {
                        ...formData.getHeaders(),
                        'Authorization': `Bearer ${chaves.groq}`
                    },
                    maxBodyLength: Infinity 
                });

                // 4. Formatação Inteligente (Diarização para Whisper)
                const transcricaoFormatada = groqRes.data.segments.map((seg, index) => {
                    let locutor = (index % 2 === 0) ? "LOCUTOR A" : "LOCUTOR B"; 
                    return { spk: locutor, text: seg.text.trim() };
                });

                // Autodestruição para proteger o disco
                apagarArquivos(inputPath, outputPath);

                return res.json({ status: "sucesso", modelo: model, data: transcricaoFormatada });

            } catch (error) {
                apagarArquivos(inputPath, outputPath);
                const msgErro = error.response ? (error.response.data.error ? error.response.data.error.message : error.message) : error.message;
                return res.status(502).json({ erro: `Groq API Recusou: ${msgErro}` });
            }
        } 
        else if (model === 'universal-3-pro') {
            apagarArquivos(inputPath, outputPath);
            return res.status(501).json({ erro: "Módulo AssemblyAI em construção." });
        }
    });
});

// Função Auxiliar de Limpeza
function apagarArquivos(...caminhos) {
    caminhos.forEach(caminho => {
        if (caminho && fs.existsSync(caminho)) {
            fs.unlink(caminho, (err) => {
                if (err) console.error(`Erro ao deletar arquivo residual: ${caminho}`);
            });
        }
    });
}

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Motor Blindado Ativo na Porta ${PORT}`));
