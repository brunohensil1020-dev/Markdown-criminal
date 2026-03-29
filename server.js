const express = require('express');
const multer = require('multer');
const pdf = require('pdf-parse');
const path = require('path');
const fs = require('fs');
const cors = require('cors');
const { exec } = require('child_process');
const axios = require('axios');
const FormData = require('form-data');
const AdmZip = require('adm-zip');

const app = express();
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json({ limit: '1000mb' }));
app.use(express.urlencoded({ limit: '1000mb', extended: true }));

const UPLOADS_DIR = path.join(__dirname, 'uploads');
const SECRETS_DIR = path.join(__dirname, 'secrets');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR);
if (!fs.existsSync(SECRETS_DIR)) fs.mkdirSync(SECRETS_DIR);

const uploadPDF = multer({ storage: multer.memoryStorage(), limits: { fileSize: 200 * 1024 * 1024 } });
const uploadAudio = multer({ dest: UPLOADS_DIR, limits: { fileSize: 1000 * 1024 * 1024 } });
const SECRETS_PATH = path.join(SECRETS_DIR, 'keys.json');

// ============================================================
// COFRE NEURAL: SALVAMENTO SEGURO E STATUS
// ============================================================
app.post('/save-keys', express.json(), (req, res) => {
    const chavesAtuais = getKeys() || {};
    const novasChaves = req.body;
    
    // CORREÇÃO: Só atualiza a chave no cofre se o usuário realmente digitou algo.
    // Isso impede que um campo vazio apague a chave que já estava salva.
    Object.keys(novasChaves).forEach(key => {
        if (novasChaves[key] && novasChaves[key].trim() !== '') {
            chavesAtuais[key] = novasChaves[key].trim();
        }
    });
    
    fs.writeFileSync(SECRETS_PATH, JSON.stringify(chavesAtuais));
    res.json({ status: "sucesso", msg: "Cofre Neural atualizado com segurança." });
});

// NOVA ROTA: Diz ao Front-end se as chaves existem (sem mostrar a chave real)
app.get('/status-cofre', (req, res) => {
    const chaves = getKeys() || {};
    res.json({
        groq: !!chaves.groq,
        assembly: !!chaves.assembly,
        claude: !!chaves.claude,
        gemini: !!chaves.gemini,
        escavador: !!chaves.escavador
    });
});
const getKeys = () => fs.existsSync(SECRETS_PATH) ? JSON.parse(fs.readFileSync(SECRETS_PATH, 'utf8')) : null;

function apagarArquivos(...caminhos) { caminhos.forEach(c => { if (c && fs.existsSync(c)) fs.unlink(c, () => {}); }); }

// BIBLIOTECA DE VERBOS (Usada APENAS no Lab Training)
const BIBLIOTECA_VERBOS = [
    "matar", "ofender", "lesionar", "perigo", "abandonar", "rixa", "caluniar", "difamar", "injuriar", "ameaçar", "constranger",
    "subtrair", "roubar", "extorquir", "usurpar", "dano", "apropriar", "estelionato", "fraudar", "receptar", "violar", "estuprar",
    "assediar", "corromper", "falsificar", "adulterar", "peculato", "concussão", "corrupção", "prevaricação", "desacatar", "contrabandear",
    "adquirir", "vender", "expor", "oferecer", "ter em depósito", "transportar", "trazer consigo", "guardar", "ministrar", "entregar", "disparar", "portar"
];

// === FILTROS E-SAJ (compartilhados) ===
const MANTER_PRIORIDADE = [
    "certidão de oficial de justiça", "despacho", "documentos intermediarios-delpol",
    "interlocutória", "inquerito", "inquérito", "manifestação da defensoria",
    "petição", "termo de audiencia", "termo de audiência"
];
const IGNORAR_LIXO = [
    "ficha do réu", "ficha do reu", "ato ordinatório", "ato ordinatorio",
    "certidão", "certidao", "antecedentes penais", "copias extraídas", "cópias extraídas",
    "mandado", "dilação de prazo", "ofício", "oficio", "outros documentos", "termo"
];

// Função compartilhada de extração com FILTROS DINÂMICOS (Front + Back)
async function extrairTextoFiltrado(fileBuffer, originalName, customManter = "", customIgnorar = "") {
    let textoConsolidado = "";
    const aceitos = [];
    const removidos = [];

    // Mescla as regras fixas do servidor com as regras digitadas por você na tela
    const extraManter = customManter.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
    const extraIgnorar = customIgnorar.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
    
    const regrasManter = [...MANTER_PRIORIDADE, ...extraManter];
    const regrasIgnorar = [...IGNORAR_LIXO, ...extraIgnorar];

    if (originalName.toLowerCase().endsWith('.zip')) {
        const zip = new AdmZip(fileBuffer);
        for (const entry of zip.getEntries()) {
            if (!entry.isDirectory && entry.name.toLowerCase().endsWith('.pdf')) {
                
                const nomeArquivo = entry.name.toLowerCase(); 
                
                // Usa as novas listas mescladas para tomar a decisão
                const ehLixo = regrasIgnorar.some(p => nomeArquivo.includes(p));
                const blindado = regrasManter.some(p => nomeArquivo.includes(p));
                
                if (ehLixo && !blindado) {
                    removidos.push(entry.name);
                    continue;
                }
                try {
                    const pdfData = await pdf(entry.getData());
                    textoConsolidado += `\n\n=== PEÇA PROCESSUAL: ${entry.name} ===\n${pdfData.text}`;
                    aceitos.push(entry.name);
                } catch (err) { removidos.push(`${entry.name} (erro leitura)`); }
            }
        }
    } else if (originalName.toLowerCase().endsWith('.pdf')) {
        textoConsolidado = (await pdf(fileBuffer)).text;
        aceitos.push(originalName);
    } else {
        throw new Error("Envie um .ZIP do E-SAJ ou um .PDF único.");
    }

    return { textoConsolidado, aceitos, removidos };
}

// ============================================================
// MOTOR DE LEITURA DE PDF (FALLBACK: GEMINI -> CLAUDE -> GROQ)
// ============================================================
async function lerPDFcomIA(textoBruto, chaves) {
    const promptSistema = `Você é um Analista Jurídico Sênior especializado em auditoria de processos criminais. 
Sua função é ler o texto do processo e extrair os dados EXATAMENTE no formato JSON solicitado.

REGRAS ABSOLUTAS:
1. Nunca invente dados.
2. Se não achar, o valor DEVE ser: "não localizado no PDF analisado".
3. Anonimize nomes de partes (Primeiro nome + Iniciais). Ex: João da Silva -> João S.
4. Retorne ÚNICO e EXCLUSIVAMENTE um objeto JSON válido, sem comentários.

CAMPOS A EXTRAIR:
{
  "campoA_denuncia": "Acusados, data do crime, vítimas, artigos imputados e testemunhas da acusação.",
  "campoB_bo": "Data/hora do registro, data/hora do fato e tempo decorrido.",
  "campoC_depoimentos": "Resumo objective e trechos-chave de vítimas e testemunhas.",
  "campoD_laudos": "Conclusões de laudos periciais e certidões.",
  "campoE_delegado": "Resumo do relatório policial focando em verbos de ação e provas.",
  "campoF_incidentes": "Data do recebimento da denúncia, resposta à acusação e alegações finais.",
  "campoG_cronometria": "Tempo decorrido desde o recebimento da denúncia.",
  "campoH_sentenca": "Resultado, artigos, pena, regime e último despacho (se houver).",
  "relatorioFatos": "Crie um texto contínuo chamado DOS FATOS resumindo o caso de forma imparcial."
}`;

    let logErros = [];

    // 1. TENTATIVA 1: GEMINI 1.5 PRO (Caminhão de Carga: Suporta 2 Milhões de Tokens)
    if (chaves.gemini) {
        try {
            const promptCompleto = promptSistema + "\n\n=== TEXTO DO PROCESSO ===\n" + textoBruto;
            const res = await axios.post(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-pro-latest:generateContent?key=${chaves.gemini}`, {
                contents: [{ parts: [{ text: promptCompleto }] }],
                generationConfig: { responseMimeType: "application/json" } // Força o Gemini a devolver JSON puro
            }, { headers: { 'Content-Type': 'application/json' } });
            
            return JSON.parse(res.data.candidates[0].content.parts[0].text);
        } catch (e) {
            console.error("Erro no motor Gemini:", e.response ? JSON.stringify(e.response.data) : e.message);
            logErros.push("GEMINI");
        }
    }

    // 2. TENTATIVA 2: CLAUDE 3.5 SONNET (Contexto longo: Suporta 200 mil Tokens)
    if (chaves.claude) {
         try {
            const res = await axios.post('https://api.anthropic.com/v1/messages', {
                model: "claude-3-5-sonnet-20241022", max_tokens: 8000,
                messages: [{ role: "user", content: promptSistema + "\n\n=== TEXTO DO PROCESSO ===\n" + textoBruto }]
            }, { headers: { 'x-api-key': chaves.claude, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' } });
            
            // Limpa as marcações Markdown que o Claude costuma adicionar
            let textoResposta = res.data.content[0].text;
            textoResposta = textoResposta.replace(/```json/g, '').replace(/```/g, '').trim();
            return JSON.parse(textoResposta);
        } catch (e) {
            console.error("Erro no motor Claude:", e.response ? JSON.stringify(e.response.data) : e.message);
            logErros.push("CLAUDE");
        }
    }

    // 3. TENTATIVA 3: GROQ (Ferrari com porta-malas pequeno: Suporta apenas 12 mil Tokens)
    if (chaves.groq) {
         try {
            const res = await axios.post('https://api.groq.com/openai/v1/chat/completions', {
                model: "llama-3.3-70b-versatile",
                messages: [
                    { role: "system", content: promptSistema },
                    // CORTAMOS O TEXTO EM 35.000 CARACTERES PARA NÃO ESTOURAR O LIMITE DA CONTA GRÁTIS
                    { role: "user", content: textoBruto.substring(0, 35000) } 
                ],
                response_format: { type: "json_object" },
                temperature: 0.1
            }, { headers: { 'Authorization': `Bearer ${chaves.groq}` } });
            
            return JSON.parse(res.data.choices[0].message.content);
        } catch (e) {
            console.error("Erro no motor Groq:", e.response ? e.response.data.error.message : e.message);
            logErros.push("GROQ");
        }
    }

    // Se as 3 IA's falharem (ou se você não tiver salvo as chaves no Cofre)
    throw new Error(`Falha Crítica. Motores tentados e falhos: ${logErros.length > 0 ? logErros.join(' -> ') : 'NENHUMA CHAVE CADASTRADA'}. Vá na Aba Cofre API e cadastre a chave do Gemini ou Claude.`);
}

// --- ROTA DE EXTRAÇÃO DE TEXTO LIMPO ---
app.post('/extrair-texto', uploadPDF.single('file'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ erro: "Arquivo ausente." });

        // Captura os filtros customizados enviados pelo HTML
        const { customManter, customIgnorar } = req.body;
        
        const { textoConsolidado, aceitos, removidos } = await extrairTextoFiltrado(req.file.buffer, req.file.originalname, customManter, customIgnorar);
        if (!textoConsolidado) return res.status(400).json({ erro: "Todos os PDFs foram filtrados como irrelevantes." });

        const textoLimpo = textoConsolidado.replace(/\s+/g, ' ').trim();
        res.json({ status: "sucesso", totalAceitos: aceitos.length, totalRemovidos: removidos.length, aceitos, removidos, caracteres: textoLimpo.length, textoLimpo });
    } catch (e) { res.status(500).json({ erro: e.message }); }
});

// --- ROTA DE AUDITORIA IMPARCIAL (Com Falback Integrado) ---
app.post('/analisar', uploadPDF.single('file'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ erro: "Arquivo ausente." });
        
        // Pega o cofre INTEIRO e manda para a função lerPDFcomIA
        const chaves = getKeys();
        if (!chaves) return res.status(403).json({ erro: "Cofre Neural vazio. Cadastre as chaves de API na Aba 4." });

        // Captura os filtros customizados enviados pelo HTML
        const { customManter, customIgnorar } = req.body;

        const { textoConsolidado, aceitos, removidos } = await extrairTextoFiltrado(req.file.buffer, req.file.originalname, customManter, customIgnorar);
        if (!textoConsolidado) return res.status(400).json({ erro: "Todos os PDFs foram filtrados como lixo processual." });

        // A MÁGICA ACONTECE AQUI: Passamos todas as chaves para a IA escolher qual motor usar
        const detalhes = await lerPDFcomIA(textoConsolidado.replace(/\s+/g, ' '), chaves);
        
        res.json({ status: "sucesso", detalhes, arquivosLidos: aceitos, arquivosIgnorados: removidos });
    } catch (e) {
        res.status(500).json({ erro: e.message });
    }
});

// --- ROTA DE TRANSCRIÇÃO INTEGRAL (Aba 2) ---
app.post('/transcrever', uploadAudio.single('audio'), async (req, res) => {
    const { model } = req.body; 
    const inputPath = req.file.path;
    const outputPath = `${inputPath}.wav`;
    const chaves = getKeys();

    if (model.includes('whisper') && (!chaves || !chaves.groq)) {
        apagarArquivos(inputPath); return res.status(403).json({ erro: "Chave da Groq ausente." });
    }
    if (model.includes('universal') && (!chaves || !chaves.assembly)) {
        apagarArquivos(inputPath); return res.status(403).json({ erro: "Chave da AssemblyAI ausente." });
    }

    exec(`ffmpeg -i "${inputPath}" -ar 16000 -ac 1 "${outputPath}"`, async (err) => {
        if (err) { apagarArquivos(inputPath, outputPath); return res.status(500).json({ erro: "Falha na conversão FFmpeg." }); }
        
        try {
            let transcricaoFormatada = [];

            if (model.includes('whisper')) {
                const fd = new FormData();
                fd.append('file', fs.createReadStream(outputPath));
                fd.append('model', model);
                fd.append('response_format', 'verbose_json');
                fd.append('language', 'pt');

                const groqRes = await axios.post('https://api.groq.com/openai/v1/audio/transcriptions', fd, {
                    headers: { ...fd.getHeaders(), 'Authorization': `Bearer ${chaves.groq}` },
                    maxBodyLength: Infinity
                });

                transcricaoFormatada = groqRes.data.segments.map((seg, idx) => ({
                    spk: (idx % 2 === 0) ? "LOCUTOR A" : "LOCUTOR B", 
                    text: seg.text.trim() 
                }));
            } 
            else if (model === 'universal-3-pro') {
                const uploadRes = await axios.post('https://api.assemblyai.com/v2/upload', fs.createReadStream(outputPath), {
                    headers: { 'Authorization': chaves.assembly, 'Transfer-Encoding': 'chunked' }
                });

                const transcriptRes = await axios.post('https://api.assemblyai.com/v2/transcript', {
                    audio_url: uploadRes.data.upload_url, speaker_labels: true, language_code: 'pt'
                }, { headers: { 'Authorization': chaves.assembly } });

                let tId = transcriptRes.data.id;
                let isCompleted = false;
                let finalData;

                while (!isCompleted) {
                    await new Promise(resolve => setTimeout(resolve, 5000));
                    const pollRes = await axios.get(`https://api.assemblyai.com/v2/transcript/${tId}`, { headers: { 'Authorization': chaves.assembly }});
                    if (pollRes.data.status === 'completed') { isCompleted = true; finalData = pollRes.data; }
                    else if (pollRes.data.status === 'error') { throw new Error("Erro na AssemblyAI."); }
                }

                transcricaoFormatada = finalData.utterances.map(u => ({
                    spk: `SPEAKER ${u.speaker}`, text: u.text.trim()
                }));
            }

            apagarArquivos(inputPath, outputPath);
            res.json({ status: "sucesso", data: transcricaoFormatada });
        } catch (error) {
            apagarArquivos(inputPath, outputPath);
            res.status(502).json({ erro: error.message });
        }
    });
});

// --- ROTA LAB 1: ANÁLISE ESTRATÉGICA (Filtro de Verbos) ---
app.post('/estrategia', express.json(), async (req, res) => {
    try {
        const { relatorio, transcricao } = req.body;
        const chaves = getKeys();
        if (!chaves || !chaves.groq) return res.status(403).json({ erro: "Chave Groq necessária para Estratégia." });

        const promptEstrategico = `Você é um Advogado Criminalista Sênior. Cruze o Relatório PDF e a Transcrição Integral.
        BIBLIOTECA DE VERBOS NUCLEARES: ${BIBLIOTECA_VERBOS.join(", ")}.
        
        Sua missão é filtrar a transcrição e mapear APENAS as ações físicas. Retorne um JSON:
        {
          "pecaCabivel": "Analise o último despacho e diga a PEÇA e o FUNDAMENTO LEGAL.",
          "resumoVerbos": "Filtre a transcrição integral e foque EXCLUSIVAMENTE nos verbos criminais da biblioteca. O que o réu fez no BO vs o que a transcrição provou?",
          "contradicoes": "Aponte contradições baseadas estritamente nas ações físicas.",
          "tesesDefesa": "Sugira teses de defesa (Atipicidade, Insuficiência, etc)."
        }
        RELATÓRIO: ${JSON.stringify(relatorio)}
        TRANSCRIÇÃO: ${JSON.stringify(transcricao)}`;

        const response = await axios.post('https://api.groq.com/openai/v1/chat/completions', {
            model: "llama-3.3-70b-versatile",
            messages: [{ role: "user", content: promptEstrategico }],
            response_format: { type: "json_object" }, temperature: 0.2
        }, { headers: { 'Authorization': `Bearer ${chaves.groq}` }, timeout: 60000 });

        res.json({ status: "sucesso", dados: JSON.parse(response.data.choices[0].message.content) });
    } catch (e) { res.status(500).json({ erro: "Falha na geração da Estratégia." }); }
});

// ============================================================
// SISTEMA DE CASCATA PARA REDAÇÃO DE PEÇAS (FALLBACK)
// ============================================================
async function chamarClaude(prompt, chave) {
    const res = await axios.post('https://api.anthropic.com/v1/messages', {
        model: "claude-3-5-sonnet-20241022", max_tokens: 4000,
        messages: [{ role: "user", content: prompt }]
    }, { headers: { 'x-api-key': chave, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' } });
    return res.data.content[0].text;
}

async function chamarGemini(prompt, chave) {
    const res = await axios.post(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-pro-latest:generateContent?key=${chave}`, {
        contents: [{ parts: [{ text: prompt }] }]
    }, { headers: { 'Content-Type': 'application/json' } });
    return res.data.candidates[0].content.parts[0].text;
}

async function chamarGroqLlama(prompt, chave) {
    const res = await axios.post('https://api.groq.com/openai/v1/chat/completions', {
        model: "llama-3.3-70b-versatile",
        messages: [{ role: "user", content: prompt }], temperature: 0.3
    }, { headers: { 'Authorization': `Bearer ${chave}` } });
    return res.data.choices[0].message.content;
}

app.post('/redigir-peca', express.json(), async (req, res) => {
    try {
        const { modelo, estrategia, relatorio } = req.body;
        const chaves = getKeys();
        
        const promptPeca = `Como Advogado Criminalista, redija a peça judicial adequada (${estrategia.pecaCabivel}) para o réu ${relatorio.campoA_denuncia}. 
        Use as teses: ${estrategia.tesesDefesa}. Baseie-se nas contradições: ${estrategia.contradicoes}. 
        Mantenha linguagem jurídica formal e pedidos finais claros. Retorne apenas o texto da peça.`;

        const ordemCaminhos = modelo === 'gemini' 
            ? ['gemini', 'claude', 'groq'] 
            : ['claude', 'gemini', 'groq'];

        let textoPeca = "";
        let logErros = [];

        for (const motor of ordemCaminhos) {
            try {
                if (motor === 'gemini') {
                    if (chaves.gemini) { textoPeca = await chamarGemini(promptPeca, chaves.gemini); break; }
                    else { logErros.push('GEMINI (Sem Chave)'); continue; }
                } 
                else if (motor === 'claude') {
                    if (chaves.claude) { textoPeca = await chamarClaude(promptPeca, chaves.claude); break; }
                    else { logErros.push('CLAUDE (Sem Chave)'); continue; }
                }
                else if (motor === 'groq') {
                    if (chaves.groq) { textoPeca = await chamarGroqLlama(promptPeca, chaves.groq); break; }
                    else { logErros.push('GROQ (Sem Chave)'); continue; }
                }
            } catch (erroModelo) {
                console.error(`Falha no motor ${motor}:`, erroModelo.message);
                logErros.push(`${motor.toUpperCase()} (Erro na API)`);
                continue;
            }
        }

        if (!textoPeca) {
            return res.status(500).json({ erro: `Todos os motores falharam. Motivos: ${logErros.join(' -> ')}.` });
        }

        res.json({ status: "sucesso", peca: textoPeca, aviso: logErros.length > 0 ? `Fallback ativo (${logErros.join(', ')} falharam).` : null });
    } catch (e) {
        res.status(500).json({ erro: "Falha crítica no sistema de redação." });
    }
});

app.listen(process.env.PORT || 3000, () => console.log(`Cockpit Neural Online com Fallback Ativo`));
