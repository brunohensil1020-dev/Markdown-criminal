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
const ffmpegPath = require('ffmpeg-static');

const app = express();
app.use(cors());
app.use(express.json({ limit: '1000mb' }));
app.use(express.urlencoded({ limit: '1000mb', extended: true }));

// Mantém a pasta public fechada e segura para arquivos estáticos futuros
app.use(express.static(path.join(__dirname, 'public')));

// ============================================================
// SOLUÇÃO CRÍTICA: ROTA PRINCIPAL (FIM DO "CANNOT GET /")
// ============================================================
app.get('/', (req, res) => {
    const indexPath = path.join(__dirname, 'index.html');
    if (fs.existsSync(indexPath)) {
        res.sendFile(indexPath);
    } else {
        res.status(404).send("Painel não encontrado.");
    }
});
// ============================================================

const UPLOADS_DIR = path.join(__dirname, 'uploads');
const SECRETS_DIR = path.join(__dirname, 'secrets');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR);
if (!fs.existsSync(SECRETS_DIR)) fs.mkdirSync(SECRETS_DIR);

const uploadPDF = multer({ storage: multer.memoryStorage(), limits: { fileSize: 200 * 1024 * 1024 } });
// O upload de áudio agora suporta múltiplos arquivos simultâneos (até 15 de uma vez)
const uploadAudio = multer({ dest: UPLOADS_DIR, limits: { fileSize: 1000 * 1024 * 1024 } });
const SECRETS_PATH = path.join(SECRETS_DIR, 'keys.json');


const MODELOS_IA = {
    GEMINI_ANALISE: process.env.GEMINI_MODEL_ANALISE || 'gemini-2.5-flash',
    GEMINI_PECA: process.env.GEMINI_MODEL_PECA || process.env.GEMINI_MODEL_ANALISE || 'gemini-2.5-flash',
    CLAUDE_ANALISE: process.env.CLAUDE_MODEL_ANALISE || 'claude-sonnet-4-20250514',
    CLAUDE_PECA: process.env.CLAUDE_MODEL_PECA || process.env.CLAUDE_MODEL_ANALISE || 'claude-sonnet-4-20250514',
    GROQ_CHAT: process.env.GROQ_CHAT_MODEL || 'llama-3.3-70b-versatile',
    GROQ_TRANSCRICAO: process.env.GROQ_TRANSCRICAO_MODEL || 'whisper-large-v3-turbo'
};
const GROQ_CONTEXT_WINDOW_TOKENS = 131072;
const GROQ_SAFE_INPUT_TOKENS = 110000;

function estimarTokens(texto) {
    return Math.ceil(((texto || '').length) / 4);
}

function excedeJanelaGroq(texto) {
    return estimarTokens(texto) > GROQ_SAFE_INPUT_TOKENS;
}

// ============================================================
// COFRE NEURAL E SEGURANÇA
// ============================================================
app.post('/save-keys', express.json(), (req, res) => {
    const chavesAtuais = getKeys() || {};
    const novasChaves = req.body;
    Object.keys(novasChaves).forEach(key => {
        if (novasChaves[key] && novasChaves[key].trim() !== '') {
            chavesAtuais[key] = novasChaves[key].trim();
        }
    });
    fs.writeFileSync(SECRETS_PATH, JSON.stringify(chavesAtuais));
    res.json({ status: "sucesso", msg: "Cofre Neural atualizado com segurança." });
});

app.get('/status-cofre', (req, res) => {
    const chaves = getKeys() || {};
    res.json({ groq: !!chaves.groq, assembly: !!chaves.assembly, claude: !!chaves.claude, gemini: !!chaves.gemini, escavador: !!chaves.escavador });
});

const getKeys = () => {
    let chaves = {};
    if (fs.existsSync(SECRETS_PATH)) {
        try { chaves = JSON.parse(fs.readFileSync(SECRETS_PATH, 'utf8')); } catch (e) {}
    }
    // Autocaptura de chaves do ambiente (process.env)
    return {
        groq: chaves.groq || process.env.GROQ_API_KEY || null,
        assembly: chaves.assembly || process.env.ASSEMBLYAI_API_KEY || null,
        claude: chaves.claude || process.env.ANTHROPIC_API_KEY || null,
        gemini: chaves.gemini || process.env.GEMINI_API_KEY || null,
        escavador: chaves.escavador || process.env.ESCAVADOR_API_KEY || null
    };
};
function apagarArquivos(...caminhos) { caminhos.forEach(c => { if (c && fs.existsSync(c)) fs.unlink(c, () => {}); }); }

// ============================================================
// BLINDAGEM DE JSON (SHIELD)
// ============================================================
function extrairJSON(texto) {
    try {
        // Tenta limpar marcações Markdown
        const jsonLimpo = texto.replace(/```json/g, '').replace(/```/g, '').trim();
        return JSON.parse(jsonLimpo);
    } catch (e) {
        // Fallback: Busca o primeiro '{' e o último '}'
        const inicio = texto.indexOf('{');
        const fim = texto.lastIndexOf('}');
        if (inicio !== -1 && fim !== -1) {
            try {
                return JSON.parse(texto.substring(inicio, fim + 1));
            } catch (err) {
                throw new Error("JSON malformado na resposta da IA.");
            }
        }
        throw new Error("Nenhum objeto JSON localizado na resposta da IA.");
    }
}

// ============================================================
// FILTROS INTELIGENTES DO E-SAJ
// ============================================================
const MANTER_PRIORIDADE = [
    "certidão de oficial de justiça", "despacho", "documentos intermediarios-delpol", "interlocutória", 
    "inquerito", "inquérito", "manifestação da defensoria", "petição", "termo de audiencia", "termo de audiência"
];
const IGNORAR_LIXO = [
    "ficha do réu", "ficha do reu", "ato ordinatório", "ato ordinatorio", "certidão", "certidao", 
    "antecedentes penais", "copias extraídas", "cópias extraídas", "mandado", "dilação de prazo", 
    "ofício", "oficio", "outros documentos", "termo"
];

function normalizar(texto) {
    if (!texto) return "";
    return texto.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[-_]/g, '').toLowerCase();
}

// ============================================================
// EXTRAÇÃO ROBUSTA DE BO + TEXTO FILTRADO
// ============================================================
function identificarPecaBO(nomeArquivo = "", texto = "") {
    const alvo = normalizar(`${nomeArquivo} ${texto.slice(0, 3000)}`);
    const sinais = [
        "boletim de ocorrencia",
        "boletim de ocorrência",
        "ocorrencia n",
        "ocorrência n",
        "registro de ocorrencia",
        "registro de ocorrência",
        "fatos comunicados",
        "data/hora do fato",
        "historico da ocorrencia",
        "histórico da ocorrência",
        "delegacia",
        "delpol",
        "ro ",
        "b.o"
    ];
    return sinais.some(s => alvo.includes(normalizar(s)));
}

function limparQuebrasEstranhas(texto = "") {
    return String(texto || "")
        .replace(/\r/g, "\n")
        .replace(/[ \t]+/g, " ")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
}

function sanitizarValorBO(valor = "") {
    return String(valor || "")
        .replace(/\s+/g, " ")
        .replace(/\b(?:numero despacho|numero do despacho|historico|histórico|natureza|fato\(s\) comunicado\(s\)|fatos comunicados|providencia|providência)\b.*$/i, "")
        .replace(/\s+(?:numero|n[uú]mero)\s+despacho.*$/i, "")
        .replace(/\s+data\/hora\s+do\s+fato.*$/i, "")
        .replace(/\s+fato\(s\)\s+comunicado\(s\).*$/i, "")
        .replace(/\s+hist[oó]rico.*$/i, "")
        .replace(/[.;,\-–—\s]+$/g, "")
        .trim();
}

function extrairPrimeiroMatch(textos = [], padroes = []) {
    for (const texto of textos) {
        for (const padrao of padroes) {
            const m = texto.match(padrao);
            if (m && m[1]) {
                const valor = sanitizarValorBO(m[1]);
                if (valor) return valor;
            }
        }
    }
    return "";
}

function extrairPrimeiraDataHoraDeTexto(texto = "") {
    const fonte = String(texto || "").replace(/\s+/g, " ").trim();

    const matchNumerico = fonte.match(
        /(\d{1,2}\/\d{1,2}\/\d{4})(?:\s*(?:às|as)?\s*(\d{1,2})[:h](\d{2}))?/i
    );
    if (matchNumerico) {
        const [, data, hh = "00", mm = "00"] = matchNumerico;
        const [dia, mes, ano] = data.split("/").map(Number);
        return new Date(ano, mes - 1, dia, Number(hh), Number(mm), 0, 0);
    }

    const meses = {
        janeiro: 0, fevereiro: 1, março: 2, marco: 2, abril: 3, maio: 4, junho: 5,
        julho: 6, agosto: 7, setembro: 8, outubro: 9, novembro: 10, dezembro: 11
    };

    const matchExtenso = fonte.match(
        /(\d{1,2})\s+de\s+([a-zçãõáéíóú]+)\s+de\s+(\d{4})(?:\s*(?:às|as)?\s*(\d{1,2})[:h](\d{2}))?/i
    );
    if (matchExtenso) {
        const dia = Number(matchExtenso[1]);
        const mesNome = normalizar(matchExtenso[2]);
        const ano = Number(matchExtenso[3]);
        const hh = Number(matchExtenso[4] || 0);
        const mm = Number(matchExtenso[5] || 0);

        if (meses[mesNome] !== undefined) {
            return new Date(ano, meses[mesNome], dia, hh, mm, 0, 0);
        }
    }

    return null;
}

function calcularTempoDecorridoBO(dataRegistro, dataFato) {
    const dtRegistro = extrairPrimeiraDataHoraDeTexto(dataRegistro);
    const dtFato = extrairPrimeiraDataHoraDeTexto(dataFato);

    if (!dtRegistro || !dtFato || Number.isNaN(dtRegistro.getTime()) || Number.isNaN(dtFato.getTime())) {
        return "";
    }

    const diffMs = dtRegistro.getTime() - dtFato.getTime();
    if (diffMs < 0) return "";

    const minutos = Math.round(diffMs / 60000);
    const dias = Math.floor(minutos / 1440);
    const horas = Math.floor((minutos % 1440) / 60);
    const mins = minutos % 60;

    const partes = [];
    if (dias) partes.push(`${dias} dia(s)`);
    if (horas) partes.push(`${horas} hora(s)`);
    if (mins || partes.length === 0) partes.push(`${mins} minuto(s)`);

    return partes.join(" e ");
}

function extrairDadosBOPrioritarios(pecasExtraidas = [], textoFallback = "") {
    const candidatos = [];

    for (const peca of pecasExtraidas) {
        if (peca && (peca.eBo || identificarPecaBO(peca.nome, peca.texto))) {
            candidatos.push({
                origem: peca.nome || "peça sem nome",
                texto: peca.texto || ""
            });
        }
    }

    if (candidatos.length === 0 && textoFallback) {
        candidatos.push({
            origem: "texto consolidado",
            texto: textoFallback
        });
    }

    const padroesRegistro = [
        /ocorr[eê]ncia\s*n[ºo°]?\s*[:\-]?\s*[\d./-]+\s*[-–—]?\s*registrad[ao]\s*em\s*([^\n]{8,140})/i,
        /registrad[ao]\s*em\s*((?:\d{1,2}\s+de\s+[a-zçãõáéíóú]+\s+de\s+\d{4}|\d{1,2}\/\d{1,2}\/\d{4})(?:\s*(?:às|as)?\s*\d{1,2}[:h]\d{2}\s*(?:hs?|h)?)?)/i,
        /ocorr[eê]ncia\s+registrada\s+em\s+data\/hora\s*[:\-]?\s*([^\n]{8,140})/i,
        /data\/hora\s+registro\s*[:\-]?\s*([^\n]{8,140})/i
    ];

    const padroesFato = [
        /data\/hora\s+do\s+fato\s*[:\-]?\s*([^\n]{8,180})/i,
        /fato\(s\)\s+comunicado\(s\)[\s\S]{0,180}?data\/hora\s+do\s+fato\s*[:\-]?\s*([^\n]{8,180})/i,
        /data\s*\/?\s*hora\s+do\s+fato\s*[:\-]?\s*([^\n]{8,180})/i
    ];

    for (const candidato of candidatos) {
        const textoCru = limparQuebrasEstranhas(candidato.texto || "");
        const textoFlat = textoCru.replace(/\n/g, " ").replace(/\s+/g, " ").trim();

        const dataRegistro = extrairPrimeiroMatch([textoCru, textoFlat], padroesRegistro);
        const dataFato = extrairPrimeiroMatch([textoCru, textoFlat], padroesFato);
        const tempoDecorrido = calcularTempoDecorridoBO(dataRegistro, dataFato);

        if (dataRegistro || dataFato) {
            return {
                encontrado: true,
                origem: candidato.origem,
                dataRegistro,
                dataFato,
                tempoDecorrido
            };
        }
    }

    return {
        encontrado: false,
        origem: "",
        dataRegistro: "",
        dataFato: "",
        tempoDecorrido: ""
    };
}

function escapeRegExp(valor = "") {
    return String(valor).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function substituirOuInserirLinha(textoBase = "", rotulo = "", valor = "") {
    const texto = String(textoBase || "").trim();
    const linhaNova = `${rotulo}: ${valor}`;
    const re = new RegExp(`${escapeRegExp(rotulo)}\\s*:\\s*[^\\n]*`, "i");

    if (!texto) return linhaNova;
    if (re.test(texto)) return texto.replace(re, linhaNova);

    return `${linhaNova}\n${texto}`;
}

function aplicarPrioridadeBOAoJSON(detalhesJSON = {}, dadosBO = {}) {
    const saida = { ...(detalhesJSON || {}) };

    if (!dadosBO || !dadosBO.encontrado) return saida;

    if (dadosBO.dataRegistro) {
        saida.campoB_bo = substituirOuInserirLinha(saida.campoB_bo || "", "Data/hora do registro", dadosBO.dataRegistro);
        saida.campoG_cronometria = substituirOuInserirLinha(saida.campoG_cronometria || "", "Registro BO", dadosBO.dataRegistro);
    }

    if (dadosBO.dataFato) {
        saida.campoB_bo = substituirOuInserirLinha(saida.campoB_bo || "", "Data/hora do fato", dadosBO.dataFato);
    }

    if (dadosBO.tempoDecorrido) {
        saida.campoB_bo = substituirOuInserirLinha(saida.campoB_bo || "", "Tempo decorrido", dadosBO.tempoDecorrido);
    }

    return saida;
}

async function extrairTextoFiltrado(fileBuffer, originalName, customManter = "", customIgnorar = "") {
    let textoConsolidado = "";
    const aceitos = [];
    const removidos = [];
    const pecasExtraidas = [];

    const extraManter = (customManter || "").split(",").map(s => normalizar(s.trim())).filter(Boolean);
    const extraIgnorar = (customIgnorar || "").split(",").map(s => normalizar(s.trim())).filter(Boolean);
    const regrasManter = MANTER_PRIORIDADE.map(normalizar).concat(extraManter);
    const regrasIgnorar = IGNORAR_LIXO.map(normalizar).concat(extraIgnorar);

    if (originalName.toLowerCase().endsWith(".zip")) {
        const zip = new AdmZip(fileBuffer);

        for (const entry of zip.getEntries()) {
            if (!entry.isDirectory && entry.name.toLowerCase().endsWith(".pdf")) {
                const nomeArquivoNormalizado = normalizar(entry.name);
                const ehLixo = regrasIgnorar.some(p => nomeArquivoNormalizado.includes(p));
                const blindado = regrasManter.some(p => nomeArquivoNormalizado.includes(p));

                if (ehLixo && !blindado) {
                    removidos.push(entry.name);
                    continue;
                }

                try {
                    const pdfData = await pdf(entry.getData());
                    const textoPeca = limparQuebrasEstranhas(pdfData.text || "");

                    textoConsolidado += `\n\n=== PEÇA PROCESSUAL: ${entry.name} ===\n${textoPeca}`;
                    pecasExtraidas.push({
                        nome: entry.name,
                        texto: textoPeca,
                        eBo: identificarPecaBO(entry.name, textoPeca)
                    });
                    aceitos.push(entry.name);
                } catch (err) {
                    removidos.push(`${entry.name} (erro leitura)`);
                }
            }
        }
    } else if (originalName.toLowerCase().endsWith(".pdf")) {
        const pdfData = await pdf(fileBuffer);
        const textoPeca = limparQuebrasEstranhas(pdfData.text || "");

        textoConsolidado = textoPeca;
        pecasExtraidas.push({
            nome: originalName,
            texto: textoPeca,
            eBo: identificarPecaBO(originalName, textoPeca)
        });
        aceitos.push(originalName);
    } else {
        throw new Error("Envie um .ZIP do E-SAJ ou um .PDF único.");
    }

    return {
        textoConsolidado,
        pecasExtraidas,
        aceitos,
        removidos
    };
}

// ============================================================
// IA DE AUDITORIA: FALLBACK E PROMPTS PADRONIZADOS
// ============================================================
async function lerPDFcomIA(textoBruto, chaves, modeloPreferencia, dadosBOPrioritarios = null) {
    const blocoBOPrioritario = dadosBOPrioritarios && dadosBOPrioritarios.encontrado
        ? `

=== DADOS PRIORIZADOS EXTRAÍDOS AUTOMATICAMENTE DO BO ===
Origem: ${dadosBOPrioritarios.origem || "não identificada"}
Data/hora do registro do BO: ${dadosBOPrioritarios.dataRegistro || "não localizado"}
Data/hora do fato no BO: ${dadosBOPrioritarios.dataFato || "não localizado"}
Tempo decorrido entre fato e registro: ${dadosBOPrioritarios.tempoDecorrido || "não localizado"}

INSTRUÇÃO ABSOLUTA:
- Para campoB_bo e campoG_cronometria, use literalmente os valores acima quando estiverem presentes.
- Não substitua a data/hora do registro pela data/hora do fato.
- Se houver divergência entre narrativa e cabeçalho do BO, preserve o cabeçalho do BO para "Data/hora do registro".
`
        : "";

    const promptSistema = `Você é um Analista Jurídico Sênior especializado em auditoria de processos criminais digitais do e-SAJ e PJe.
Sua função é analisar autos criminais em PDF e produzir um relatório técnico, objetivo, imparcial e estritamente fiel ao conteúdo efetivamente localizado.

REGRAS ABSOLUTAS:
1. Nunca invente dados ou complete lacunas por inferência. Nunca trate alegação da acusação como fato comprovado.
2. Se um dado não for localizado, escreva exatamente: "não localizado no PDF analisado".
3. Toda afirmação relevante deve indicar a página correspondente no padrão [PÁGINA X] ou [PÁGINAS X-Y].
4. Anonimize nomes de partes, vítimas e testemunhas (Primeiro nome + Iniciais).
5. Ignore ruídos documentais (cabeçalhos, rodapés, metadados), exceto para localizar a assinatura digital do magistrado. Se a data vier da assinatura, avise: "data extraída da assinatura digital do magistrado".
6. Registre divergências entre peças de modo neutro.
7. Retorne ÚNICO E EXCLUSIVAMENTE UM OBJETO JSON VÁLIDO.
8. Use quebras de linha (\\n) para estruturar os tópicos no JSON.
9. Diferencie obrigatoriamente:
   - "Data/hora do registro" = momento em que a ocorrência foi registrada.
   - "Data/hora do fato" = momento em que o fato ocorreu.
10. Nunca preencha "Data/hora do registro" com a "Data/hora do fato".

FORMATO EXATO DE SAÍDA ESPERADA:
{
  "campoA_denuncia": "Acusados: [Nome] (Idade na data do fato: [X]).\\nVítimas: [Nome].\\nData do crime: [Data e hora].\\nArtigos imputados: [Artigos].\\nPenas em abstrato: [Pena mínima e máxima com indicação da lei vigente à data do fato].\\nNarrativa fática verbatim: \\"[Trecho literal]\\". [PÁGINA X]\\nTestemunhas: [Nome, qualidade e função].",
  "campoB_bo": "Data/hora do registro: [Data/hora].\\nData/hora do fato: [Data/hora].\\nTempo decorrido: [Cálculo].\\nLesões registradas no BO: [Local lesionado + tipo/resultado]. [PÁGINA X]\\nHistórico verbatim integral: \\"[Transcrição literal da última página do BO]\\".",
  "campoC_depoimentos": "C.1. [Nome] — [Qualidade] [PÁGINA X]\\nResumo objetivo: [Resumo neutro].\\nTrecho-chave verbatim: \\"[Trecho literal]\\".\\n[Repetir para todos os ouvidos]",
  "campoD_laudos": "D.1. Laudo [manuscrito/rascunho OU digitado/definitivo] [PÁGINAS X-Y]\\nLegibilidade: [Informar se há OCR ilegível].\\nDescrição da lesão: [Tipo, localização, dimensão].\\nRespostas aos quesitos oficiais: [Lista].\\nConclusão: [Grau da lesão e instrumento].\\n\\nD.2. Pessoas não localizadas/intimadas: [Motivos].",
  "campoE_delegado": "Delegado(a): [Nome].\\nResumo verbatim: \\"[Trecho literal]\\". [PÁGINA X]\\nVerbos de ação e provas documentadas: [Lista].",
  "campoF_incidentes": "Recebimento da denúncia: [Data da assinatura digital e juiz]. [PÁGINA X]\\nCitação do réu: [Tentativas frustradas com motivos e citação positiva].\\nResposta à acusação: [Data e tese].\\nAudiências: [Participantes e cisões].",
  "campoG_cronometria": "Data do fato: [Data]\\nRegistro BO: [Data]\\nFlagrante: [Data]\\nOferecimento da denúncia: [Data]\\nRecebimento da denúncia: [Data]\\nAudiências: [Datas]\\nAlegações finais: [Datas]\\nTempo desde o recebimento até hoje: [Cálculo]\\nTempo total desde o fato: [Cálculo]",
  "pontosChave": "I. Divergências identificadas: [Relatar contradições entre fases, horários e depoimentos com páginas].\\nII. Lacunas probatórias: [Testemunhas não ouvidas, laudos ausentes e motivos].\\nIII. Marcos cronológicos críticos: [Prazos relevantes e inércia > 90 dias].\\nIV. Observações de instrução: [Mudanças de versão, cisões atípicas].",
  "campoH_sentenca": "Último despacho ou Sentença: [Resultado, pena, regime e provas citadas]. [PÁGINA X]\\nPeça defensiva pendente: [Qual a próxima manifestação devida].",
  "relatorioFatos": "DOS FATOS\\nTrata-se de ação penal em que o Ministério Público imputou ao(s) denunciado(s) a prática, em tese, das infrações penais previstas no(s) art.(s) [X], conforme denúncia de [PÁGINAS X-Y]. A pena em abstrato, na redação vigente à data do fato ([Lei]), é de [Mínima] a [Máxima].\\nConsta na denúncia que, em [Data], na cidade de [Cidade/UF], no local [Local], o acusado, em tese, teria praticado [Verbos nucleares], em desfavor de [Vítima], conforme narrativa acusatória de [PÁGINAS X-Y].\\nA denúncia foi recebida em [Data], extraída da assinatura digital em [PÁGINA X].\\nNa fase de instrução, foram efetivamente ouvidas as testemunhas [Nomes] [PÁGINAS X-Y]. [Registrar testemunhas não ouvidas]. O acusado [foi interrogado em PÁGINA X / teve a revelia decretada].\\nAo final da instrução, o Ministério Público apresentou alegações finais postulando [Pedido], conforme [PÁGINAS X-Y].\\nA defesa apresentou alegações finais postulando [Pedido ou não localizado].\\nÉ o breve relato dos fatos."
}`;

    let logErros = [];
    let detalhesJSON = null;
    let motorUtilizado = null;

    const ordemCaminhos =
        modeloPreferencia === "claude" ? ["claude", "gemini", "groq"] :
        modeloPreferencia === "groq" ? ["groq", "claude", "gemini"] :
        ["gemini", "claude", "groq"];

    const entradaCompleta = `${promptSistema}${blocoBOPrioritario}\n\n=== TEXTO DO PROCESSO ===\n${textoBruto}`;

    for (const motor of ordemCaminhos) {
        try {
            if (motor === "gemini") {
                if (!chaves.gemini) {
                    logErros.push("[GEMINI] Sem chave");
                    continue;
                }

                const res = await axios.post(
                    `https://generativelanguage.googleapis.com/v1beta/models/${MODELOS_IA.GEMINI_ANALISE}:generateContent?key=${chaves.gemini}`,
                    {
                        contents: [{ parts: [{ text: entradaCompleta }] }],
                        generationConfig: { responseMimeType: "application/json" }
                    },
                    { headers: { "Content-Type": "application/json" } }
                );

                const textoLimpoGemini = (res.data.candidates?.[0]?.content?.parts?.[0]?.text || "")
                    .replace(/```json/g, "")
                    .replace(/```/g, "")
                    .trim();

                detalhesJSON = extrairJSON(textoLimpoGemini);
                motorUtilizado = "GEMINI";
                break;
            }

            if (motor === "claude") {
                if (!chaves.claude) {
                    logErros.push("[CLAUDE] Sem chave");
                    continue;
                }

                const res = await axios.post(
                    "https://api.anthropic.com/v1/messages",
                    {
                        model: MODELOS_IA.CLAUDE_ANALISE,
                        max_tokens: 8000,
                        messages: [{ role: "user", content: entradaCompleta }]
                    },
                    {
                        headers: {
                            "x-api-key": chaves.claude,
                            "anthropic-version": "2023-06-01",
                            "content-type": "application/json"
                        }
                    }
                );

                detalhesJSON = extrairJSON(res.data.content[0].text);
                motorUtilizado = "CLAUDE";
                break;
            }

            if (motor === "groq") {
                if (!chaves.groq) {
                    logErros.push("[GROQ] Sem chave");
                    continue;
                }

                if (excedeJanelaGroq(entradaCompleta)) {
                    logErros.push(
                        `[GROQ] Entrada estimada em ${estimarTokens(entradaCompleta)} tokens; acima do limite seguro configurado para ${MODELOS_IA.GROQ_CHAT}.`
                    );
                    continue;
                }

                const res = await axios.post(
                    "https://api.groq.com/openai/v1/chat/completions",
                    {
                        model: MODELOS_IA.GROQ_CHAT,
                        messages: [
                            { role: "system", content: promptSistema + blocoBOPrioritario },
                            { role: "user", content: textoBruto }
                        ],
                        response_format: { type: "json_object" },
                        temperature: 0.1
                    },
                    { headers: { Authorization: `Bearer ${chaves.groq}` } }
                );

                detalhesJSON = extrairJSON(res.data.choices[0].message.content);
                motorUtilizado = "GROQ";
                break;
            }
        } catch (e) {
            const msgErro =
                e.response && e.response.data && e.response.data.error
                    ? e.response.data.error.message
                    : e.message;

            logErros.push(`[${motor.toUpperCase()}] Falhou: ${msgErro}`);
        }
    }

    if (!detalhesJSON) {
        throw new Error(`As APIs falharam ao processar o texto.\n\nMOTIVOS REAIS:\n${logErros.join("\n")}`);
    }

    return { detalhesJSON, motorUtilizado, logErros };
}

// ============================================================
// ROTAS DE AUDITORIA PDF
// ============================================================
app.post("/extrair-texto", uploadPDF.single("file"), async (req, res) => {
    req.setTimeout(0);

    try {
        if (!req.file) {
            return res.status(400).json({ erro: "Arquivo ausente." });
        }

        const { customManter, customIgnorar } = req.body;
        const { textoConsolidado, pecasExtraidas, aceitos, removidos } =
            await extrairTextoFiltrado(req.file.buffer, req.file.originalname, customManter, customIgnorar);

        if (!textoConsolidado) {
            return res.status(400).json({ erro: "Todos os PDFs foram filtrados como irrelevantes." });
        }

        const dadosBOPrioritarios = extrairDadosBOPrioritarios(pecasExtraidas, textoConsolidado);
        const textoLimpoPreview = textoConsolidado.replace(/\s+/g, " ").trim();

        res.json({
            status: "sucesso",
            totalAceitos: aceitos.length,
            totalRemovidos: removidos.length,
            aceitos,
            removidos,
            caracteres: textoLimpoPreview.length,
            textoLimpo: textoLimpoPreview,
            boPrioritario: dadosBOPrioritarios.encontrado ? dadosBOPrioritarios : null
        });
    } catch (e) {
        res.status(500).json({ erro: e.message });
    }
});

app.post("/analisar", uploadPDF.single("file"), async (req, res) => {
    req.setTimeout(0);

    try {
        if (!req.file) {
            return res.status(400).json({ erro: "Arquivo ausente." });
        }

        const chaves = getKeys();
        if (!chaves) {
            return res.status(403).json({ erro: "Cofre Neural vazio. Cadastre as chaves de API." });
        }

        const { customManter, customIgnorar, modelo } = req.body;

        const { textoConsolidado, pecasExtraidas, aceitos, removidos } =
            await extrairTextoFiltrado(req.file.buffer, req.file.originalname, customManter, customIgnorar);

        if (!textoConsolidado) {
            return res.status(400).json({ erro: "Todos os PDFs foram filtrados como lixo processual." });
        }

        const dadosBOPrioritarios = extrairDadosBOPrioritarios(pecasExtraidas, textoConsolidado);

        const { detalhesJSON, motorUtilizado } = await lerPDFcomIA(
            textoConsolidado,
            chaves,
            modelo,
            dadosBOPrioritarios
        );

        const detalhesFinal = aplicarPrioridadeBOAoJSON(detalhesJSON, dadosBOPrioritarios);

        const avisoFallback =
            modelo && motorUtilizado.toLowerCase() !== modelo.toLowerCase()
                ? `A IA solicitada falhou. O motor de redundância assumiu e a extração foi feita com sucesso pelo ${motorUtilizado}.`
                : null;

        res.json({
            status: "sucesso",
            detalhes: detalhesFinal,
            arquivosLidos: aceitos,
            arquivosIgnorados: removidos,
            aviso: avisoFallback,
            motor: motorUtilizado,
            boPrioritario: dadosBOPrioritarios.encontrado ? dadosBOPrioritarios : null
        });
    } catch (e) {
        res.status(500).json({ erro: e.message });
    }
});

// ============================================================
// SISTEMA DE TRANSCRIÇÃO SIMULTÂNEA (MULTIPLE FILES)
// ============================================================
async function processarArquivoAudio(file, model, chaves) {
    const inputPath = file.path;
    const outputPath = `${inputPath}.wav`;
    
    try {
        // Execução do FFmpeg local e blindado
        await new Promise((resolve, reject) => {
            exec(`"${ffmpegPath}" -y -i "${inputPath}" -ar 16000 -ac 1 "${outputPath}"`, (err, stdout, stderr) => {
                if (err) reject(new Error(`Falha FFmpeg: ${stderr || err.message}`));
                else resolve();
            });
        });

        let transcricaoFormatada = [];

        if (model.includes('whisper')) {
            const fd = new FormData();
            fd.append('file', fs.createReadStream(outputPath));
            fd.append('model', model || MODELOS_IA.GROQ_TRANSCRICAO);
            fd.append('response_format', 'verbose_json');
            fd.append('language', 'pt');

            const groqRes = await axios.post('https://api.groq.com/openai/v1/audio/transcriptions', fd, {
                headers: { ...fd.getHeaders(), 'Authorization': `Bearer ${chaves.groq}` },
                maxBodyLength: Infinity
            });

            transcricaoFormatada = groqRes.data.segments.map((seg) => ({
                spk: "FALA CAPTURADA", text: seg.text.trim() 
            }));
        } 
        else if (model === 'universal-3-pro') {
            // CORREÇÃO CRÍTICA: Usar fs.readFileSync evita o Erro 400 da AssemblyAI 
            const audioData = fs.readFileSync(outputPath);
            
            const uploadRes = await axios.post('https://api.assemblyai.com/v2/upload', audioData, {
                headers: { 'Authorization': chaves.assembly, 'Content-Type': 'application/octet-stream' },
                maxBodyLength: Infinity
            });

            const transcriptRes = await axios.post('https://api.assemblyai.com/v2/transcript', {
                audio_url: uploadRes.data.upload_url,
                speaker_labels: true,
                language_detection: true,
                speech_models: ['universal-3-pro', 'universal-2']
            }, { headers: { 'Authorization': chaves.assembly } });

            let tId = transcriptRes.data.id;
            let isCompleted = false; let finalData;

            while (!isCompleted) {
                await new Promise(resolve => setTimeout(resolve, 5000));
                const pollRes = await axios.get(`https://api.assemblyai.com/v2/transcript/${tId}`, { headers: { 'Authorization': chaves.assembly }});
                if (pollRes.data.status === 'completed') { isCompleted = true; finalData = pollRes.data; }
                else if (pollRes.data.status === 'error') { throw new Error("A API AssemblyAI falhou ao decodificar a fala."); }
            }

            transcricaoFormatada = finalData.utterances.map(u => ({
                spk: `SPEAKER ${u.speaker}`, text: u.text.trim()
            }));
        }

        return { arquivo: file.originalname, status: "sucesso", dados: transcricaoFormatada };

    } catch (error) {
        const erroReal = error.response && error.response.data ? JSON.stringify(error.response.data) : error.message;
        return { arquivo: file.originalname, status: "erro", erro: erroReal };
    } finally {
        apagarArquivos(inputPath, outputPath);
    }
}

// Rota capaz de receber de 1 a 15 áudios simultaneamente
app.post('/transcrever', uploadAudio.array('audios', 15), async (req, res) => {
    req.setTimeout(0);
    const model = req.body.model || 'universal-3-pro'; // Garante que nunca seja undefined
    const chaves = getKeys();

    if (model.includes('whisper') && (!chaves || !chaves.groq)) return res.status(403).json({ erro: "Chave da Groq ausente." });
    if (model.includes('universal') && (!chaves || !chaves.assembly)) return res.status(403).json({ erro: "Chave da AssemblyAI ausente." });
    if (!req.files || req.files.length === 0) return res.status(400).json({ erro: "Nenhum arquivo de áudio foi enviado." });

    try { fs.chmodSync(ffmpegPath, 0o755); } catch (e) {
        console.warn('Aviso: Não foi possível aplicar chmod no ffmpeg. Se estiver no Linux, as conversões podem falhar.');
    }

    try {
        // Executa a conversão e transcrição de TODOS os arquivos simultaneamente na nuvem
        const resultados = await Promise.all(req.files.map(file => processarArquivoAudio(file, model, chaves)));
        res.json({ status: "sucesso", resultados });
    } catch (e) {
        res.status(500).json({ erro: `Falha Crítica no Processador: ${e.message}` });
    }
});

// ============================================================
// LAB TRAINING E ESTRATÉGIAS
// ============================================================
const BIBLIOTECA_VERBOS = [
    "matar", "ofender", "lesionar", "perigo", "abandonar", "rixa", "caluniar", "difamar", "injuriar", "ameaçar", "constranger",
    "subtrair", "roubar", "extorquir", "usurpar", "dano", "apropriar", "estelionato", "fraudar", "receptar", "violar", "estuprar",
    "assediar", "corromper", "falsificar", "adulterar", "peculato", "concussão", "corrupção", "prevaricação", "desacatar", "contrabandear",
    "adquirir", "vender", "expor", "oferecer", "ter em depósito", "transportar", "trazer consigo", "guardar", "ministrar", "entregar", "disparar", "portar"
];

app.post('/estrategia', express.json(), async (req, res) => {
    req.setTimeout(0); // Essencial para o Lab Training não esgotar o tempo
    try {
        const { relatorio, transcricoesLimpas } = req.body;
        const chaves = getKeys();
        if (!chaves) return res.status(403).json({ erro: "Cofre Neural vazio. Cadastre as chaves." });

        const promptEstrategico = `Você é um Advogado Criminalista Sênior. Cruze o Relatório PDF e as Transcrições Integrais em anexo.
        BIBLIOTECA DE VERBOS NUCLEARES: ${BIBLIOTECA_VERBOS.join(", ")}.
        
        Sua missão é cruzar a transcrição com a denúncia e mapear APENAS as ações. Retorne ÚNICO E EXCLUSIVAMENTE UM JSON:
        {
          "pecaCabivel": "Analise o último despacho e diga a PEÇA e o FUNDAMENTO LEGAL.",
          "resumoVerbos": "O que o réu fez segundo a denúncia vs o que a transcrição provou?",
          "contradicoes": "Aponte contradições baseadas estritamente nas ações físicas.",
          "tesesDefesa": "Sugira teses de defesa reais (Atipicidade, Insuficiência probatória art 386 CPP, etc)."
        }
        RELATÓRIO: ${JSON.stringify(relatorio)}
        TRANSCRIÇÕES: ${JSON.stringify(transcricoesLimpas)}`;

        const ordemCaminhos = ['claude', 'gemini', 'groq'];
        let dadosEstrategia = null;
        let logErros = [];

        for (const motor of ordemCaminhos) {
            try {
                if (motor === 'claude' && chaves.claude) {
                    const res = await axios.post('https://api.anthropic.com/v1/messages', {
                        model: MODELOS_IA.CLAUDE_PECA, max_tokens: 4000,
                        messages: [{ role: "user", content: promptEstrategico }]
                    }, { headers: { 'x-api-key': chaves.claude, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' } });
                    dadosEstrategia = extrairJSON(res.data.content[0].text); break;
                }
                else if (motor === 'gemini' && chaves.gemini) {
                    const res = await axios.post(`https://generativelanguage.googleapis.com/v1beta/models/${MODELOS_IA.GEMINI_ANALISE}:generateContent?key=${chaves.gemini}`, { // <-- 1.5 PRO
                        contents: [{ parts: [{ text: promptEstrategico }] }],
                        generationConfig: { responseMimeType: "application/json" }
                    }, { headers: { 'Content-Type': 'application/json' } });
                    dadosEstrategia = extrairJSON(res.data.candidates[0].content.parts[0].text); break;
                }
                else if (motor === 'groq' && chaves.groq) {
                    // A TRAVA DE SEGURANÇA: Se o texto for maior que o limite gratuito, force o Fallback para Gemini/Claude
                    if (excedeJanelaGroq(promptEstrategico)) {
                        logErros.push(`[GROQ] Texto de cruzamento estimado em ${estimarTokens(promptEstrategico)} tokens; acima do limite seguro configurado para ${MODELOS_IA.GROQ_CHAT}.`);
                        continue; 
                    }
                    const res = await axios.post('https://api.groq.com/openai/v1/chat/completions', {
                        model: MODELOS_IA.GROQ_CHAT, 
                        messages: [{ role: "user", content: promptEstrategico }], 
                        response_format: { type: "json_object" }, temperature: 0.2
                    }, { headers: { 'Authorization': `Bearer ${chaves.groq}` } });
                    dadosEstrategia = extrairJSON(res.data.choices[0].message.content); break;
                }
            } catch (e) {
                logErros.push(`[${motor.toUpperCase()}]`);
            }
        }

        if (!dadosEstrategia) return res.status(500).json({ erro: `Falha na Inteligência Estratégica. Tentativas frustradas: ${logErros.join(' -> ')}` });
        
        res.json({ status: "sucesso", dados: dadosEstrategia });
    } catch (e) { res.status(500).json({ erro: "Falha geral na geração da Estratégia." }); }
});

async function chamarClaude(prompt, chave) {
    const res = await axios.post('https://api.anthropic.com/v1/messages', {
        model: MODELOS_IA.CLAUDE_PECA,
        max_tokens: 4000,
        messages: [{ role: "user", content: prompt }]
    }, { headers: { 'x-api-key': chave, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' } });
    return res.data.content[0].text;
}

async function chamarGemini(prompt, chave) {
    const res = await axios.post(`https://generativelanguage.googleapis.com/v1beta/models/${MODELOS_IA.GEMINI_PECA}:generateContent?key=${chave}`, {
        contents: [{ parts: [{ text: prompt }] }]
    }, { headers: { 'Content-Type': 'application/json' } });
    return res.data.candidates[0].content.parts[0].text;
}

async function chamarGroqLlama(prompt, chave) {
    if (excedeJanelaGroq(prompt)) {
        throw new Error(`Entrada grande demais para ${MODELOS_IA.GROQ_CHAT}: ${estimarTokens(prompt)} tokens estimados.`);
    }

    const res = await axios.post('https://api.groq.com/openai/v1/chat/completions', {
        model: MODELOS_IA.GROQ_CHAT,
        messages: [{ role: "user", content: prompt }],
        temperature: 0.3
    }, { headers: { 'Authorization': `Bearer ${chave}` } });
    return res.data.choices[0].message.content;
}

app.post('/redigir-peca', express.json(), async (req, res) => {
    req.setTimeout(0); 
    try {
        const { modelo, estrategia, relatorio } = req.body;
        const chaves = getKeys();
        
        const promptPeca = `Como Advogado Criminalista, redija a peça judicial adequada (${estrategia.pecaCabivel}) para o réu ${relatorio.campoA_denuncia}. 
        Use as teses: ${estrategia.tesesDefesa}. Baseie-se nas contradições: ${estrategia.contradicoes}. Mantenha linguagem formal.`;

        const ordemCaminhos = modelo === 'gemini' ? ['gemini', 'claude', 'groq'] : ['claude', 'gemini', 'groq'];
        let textoPeca = ""; let logErros = [];

        for (const motor of ordemCaminhos) {
            try {
                if (motor === 'gemini') { if (chaves.gemini) { textoPeca = await chamarGemini(promptPeca, chaves.gemini); break; } else { logErros.push('GEMINI'); continue; } } 
                else if (motor === 'claude') { if (chaves.claude) { textoPeca = await chamarClaude(promptPeca, chaves.claude); break; } else { logErros.push('CLAUDE'); continue; } }
                else if (motor === 'groq') { if (chaves.groq) { textoPeca = await chamarGroqLlama(promptPeca, chaves.groq); break; } else { logErros.push('GROQ'); continue; } }
            } catch (err) { logErros.push(`${motor.toUpperCase()} (Erro)`); }
        }
        if (!textoPeca) return res.status(500).json({ erro: `Falha. Tentativas: ${logErros.join(' -> ')}.` });
        res.json({ status: "sucesso", peca: textoPeca, aviso: logErros.length > 0 ? `Fallback ativo (${logErros.join(', ')} falharam).` : null });
    } catch (e) { res.status(500).json({ erro: "Erro Crítico." }); }
});

app.listen(process.env.PORT || 3000, () => {
    console.log(`Cockpit Neural Online na porta ${process.env.PORT || 3000}`);
    const chavesStatus = getKeys() || {};
    console.log('--- STATUS DO COFRE (secrets/keys.json) ---');
    console.log(`[GROQ]: ${chavesStatus.groq ? 'ATIVA ✅' : 'AUSENTE ❌'}`);
    console.log(`[ASSEMBLY_AI]: ${chavesStatus.assembly ? 'ATIVA ✅' : 'AUSENTE ❌'}`);
    console.log(`[CLAUDE]: ${chavesStatus.claude ? 'ATIVA ✅' : 'AUSENTE ❌'}`);
    console.log(`[GEMINI]: ${chavesStatus.gemini ? 'ATIVA ✅' : 'AUSENTE ❌'}`);
    console.log(`[ESCAVADOR]: ${chavesStatus.escavador ? 'ATIVA ✅' : 'AUSENTE ❌'}`);
    console.log('-------------------------------------------');
});
